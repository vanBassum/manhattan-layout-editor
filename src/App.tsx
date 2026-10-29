import { useEffect, useMemo, useRef, useState } from 'react'
import { connectAgentBridge } from './agentBridge'
import { applyBatch, describeProject, findProblems, layoutBounds, moveComponent, moveIsland, resetLeads as resetLeadsOf, setFootprint, setIsland, setLeadEnd } from './agentCommands'
import { Canvas, type LayerName, type Layers, type LayerView, type MoveMode, type Tool } from './Canvas'
import { exportDxf } from './exportDxf'
import { downloadText, exportSvg } from './exportSvg'
import { FootprintDialog } from './FootprintDialog'
import { boundsOf } from './geometry'
import {
  analyzeLeads,
  changeFootprints,
  chooseResistors,
  createLayout,
  findSpacingViolations,
  findSplitNets,
  keepFootprintChoices,
  withFootprintChoices,
} from './layout'
import { parseNetlist } from './netlist'
import { findStrategy, STRATEGIES } from './optimize'
import { AiHelpDialog, ComponentList, Icon, LayerToggles, Section, SelectionDetails, ToolGroup, Validation } from './panels'
import {
  DEFAULT_SETTINGS,
  emptyProject,
  loadTabs,
  newTabId,
  parseStoredProject,
  parseStoredTabs,
  projectFromFile,
  projectToFile,
  projectKey,
  readProject,
  rememberActiveTab,
  removeProject,
  TABS_KEY,
  writeProject,
  writeTabs,
  type ProjectTab,
} from './projectStore'
import { canvasToPng } from './screenshot'
import { selectedRefs, selectionOf } from './selection'
import { screenshotHidden } from './hiddenScreenshot'
import type { Layout, Netlist, Placement, Project, Selection, Settings } from './types'

const UNDO_LIMIT = 100
const SNAP_OPTIONS = [0, 0.25, 0.5, 1, 1.27, 2.54]
// Layer visibility is a per-browser view preference, deliberately not part of the project.
const LAYERS_KEY = 'manhattan-layout-editor/layers'
const SHOWN: LayerView = { visible: true, opacity: 1 }
const ALL_LAYERS: Layers = { islands: SHOWN, parts: SHOWN, netLabels: SHOWN, leads: SHOWN, grid: SHOWN }

/** Reads a stored layer setting, including the older true/false and 'on'/'faded'/'off' forms. */
function parseLayerView(value: unknown): LayerView {
  if (value === false || value === 'off') return { visible: false, opacity: 1 }
  if (value === 'faded') return { visible: true, opacity: 0.15 }
  if (typeof value === 'object' && value !== null) {
    const { visible, opacity } = value as Partial<LayerView>
    return { visible: visible !== false, opacity: typeof opacity === 'number' ? Math.min(1, Math.max(0, opacity)) : 1 }
  }
  return SHOWN
}

function loadLayers(): Layers {
  try {
    const stored = localStorage.getItem(LAYERS_KEY)
    if (!stored) return ALL_LAYERS
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const layers = { ...ALL_LAYERS }
    for (const layer of Object.keys(layers) as LayerName[]) layers[layer] = parseLayerView(parsed[layer])
    return layers
  } catch {
    return ALL_LAYERS
  }
}

/** The tab's project with a new netlist; it stays the same project, so it keeps its guid. */
function projectFromNetlist(name: string, text: string, current: Project, keepLayout: boolean): Project {
  const netlist = parseNetlist(text)
  return {
    guid: current.guid,
    name,
    netlist,
    layout: createLayout(netlist, keepLayout ? current.layout : undefined),
    settings: keepLayout ? current.settings : DEFAULT_SETTINGS,
  }
}

/** The project with the editor's footprint choices applied: what drawing, checks and optimizers should see. */
const asBuilt = (project: Project): Project => ({
  ...project,
  netlist: withFootprintChoices(project.netlist, project.layout.placements),
})

/** The layout after an agent's edit command. `current` is as built; `imported` is the netlist as imported. */
function agentLayoutEdit(command: string, args: Record<string, unknown>, current: Project, imported: Netlist): Layout {
  switch (command) {
    case 'move_component':
      return moveComponent(current, args)
    case 'set_lead_end':
      return setLeadEnd(current, args)
    case 'reset_leads':
      return resetLeadsOf(current, args)
    case 'set_island':
      return setIsland(current, args)
    case 'move_island':
      return moveIsland(current, args)
    case 'batch':
      return applyBatch(current, args)
    case 'run_optimizer': {
      const optimized = findStrategy(String(args.strategy)).run(current.netlist, current.settings)
      return keepFootprintChoices(optimized, current.layout)
    }
    case 'set_resistor_footprint':
      if (args.footprint !== 'through-hole' && args.footprint !== '1206') {
        throw new Error('"footprint" must be "through-hole" or "1206"')
      }
      return chooseResistors(imported, current.layout, args.footprint)
    case 'set_footprint':
      return setFootprint(current, imported, args)
    default:
      throw new Error(`Unknown command "${command}"`)
  }
}

interface History {
  undo: Layout[]
  redo: Layout[]
}

export function App() {
  const [initialTabs] = useState(loadTabs)
  const [tabs, setTabs] = useState<ProjectTab[]>(initialTabs.tabs)
  const [activeId, setActiveId] = useState(initialTabs.activeId)
  const [project, setProject] = useState<Project>(() => readProject(initialTabs.activeId))
  const [selection, setSelection] = useState<Selection>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [moveMode, setMoveMode] = useState<MoveMode>('part')
  const [fitRequest, setFitRequest] = useState(1)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const projectFileInputRef = useRef<HTMLInputElement>(null)
  const undoStack = useRef<Layout[]>([])
  const redoStack = useRef<Layout[]>([])
  /** Undo history of the tabs that are not shown, so switching back keeps it. */
  const parkedHistory = useRef(new Map<string, History>())
  const [agentConnected, setAgentConnected] = useState(false)
  const [showAiHelp, setShowAiHelp] = useState(false)
  /** Parts checked when the footprint dialog opened; null while it is closed. */
  const [footprintDialogRefs, setFootprintDialogRefs] = useState<string[] | null>(null)
  const [layers, setLayersState] = useState<Layers>(loadLayers)
  const { netlist, layout, settings } = project
  const builtNetlist = useMemo(() => withFootprintChoices(netlist, layout.placements), [netlist, layout.placements])

  // Latest project, also between a change and the next render: agent commands can arrive back to back.
  const projectRef = useRef(project)
  projectRef.current = project

  const replaceLayout = (next: Layout) => {
    projectRef.current = { ...projectRef.current, layout: next }
    setProject(projectRef.current)
  }

  /** Call right before changing the layout, so the change can be undone. */
  const rememberLayout = () => {
    undoStack.current = [...undoStack.current.slice(-(UNDO_LIMIT - 1)), projectRef.current.layout]
    redoStack.current = []
  }

  const undo = () => {
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(projectRef.current.layout)
    replaceLayout(previous)
    setSelection(null)
  }

  const redo = () => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(projectRef.current.layout)
    replaceLayout(next)
    setSelection(null)
  }

  /** Applies an agent's edit like any other edit (undoable) and reports what is still wrong. */
  const applyAgentEdit = (next: Layout) => {
    rememberLayout()
    replaceLayout(next)
    return { problems: findProblems(asBuilt(projectRef.current)) }
  }

  /** The tab an agent command is for: its "project" argument (tab id or name), else the shown tab. */
  const agentTarget = (project: unknown): string => {
    if (project === undefined || project === '') return activeId
    const wanted = String(project)
    const byId = tabs.find((t) => t.id === wanted)
    if (byId) return byId.id
    const byName = tabs.filter((t) => t.name.toLowerCase() === wanted.toLowerCase())
    if (byName.length === 1) return byName[0].id
    const known = tabs.map((t) => `${t.name} (${t.id})`).join(', ')
    throw new Error(`${byName.length > 1 ? 'Several' : 'No'} projects named "${wanted}"; use the id. Open: ${known}`)
  }

  /** Changes a tab that is not shown: straight in storage, with its own undo history. */
  const editHiddenTab = (id: string, stored: Project, next: Layout) => {
    const history = parkedHistory.current.get(id) ?? { undo: [], redo: [] }
    parkedHistory.current.set(id, { undo: [...history.undo.slice(-(UNDO_LIMIT - 1)), stored.layout], redo: [] })
    const updated = { ...stored, layout: next }
    writeProject(id, updated)
    return { problems: findProblems(asBuilt(updated)) }
  }

  const undoHiddenTab = (id: string, stored: Project, direction: 'undo' | 'redo') => {
    const history = parkedHistory.current.get(id) ?? { undo: [], redo: [] }
    const from = direction === 'undo' ? history.undo : history.redo
    const to = direction === 'undo' ? history.redo : history.undo
    const restored = from.pop()
    if (restored) {
      to.push(stored.layout)
      parkedHistory.current.set(id, history)
      writeProject(id, { ...stored, layout: restored })
    }
    return { problems: findProblems(asBuilt({ ...stored, layout: restored ?? stored.layout })) }
  }

  const handleAgentCommand = useRef<(command: string, args: Record<string, unknown>) => unknown>(() => undefined)
  handleAgentCommand.current = (command, args) => {
    if (command === 'list_projects') {
      return { projects: tabs.map((t) => ({ id: t.id, name: t.name, shown: t.id === activeId })) }
    }
    const targetId = agentTarget(args.project)
    const shown = targetId === activeIdRef.current
    const stored = shown ? projectRef.current : readProject(targetId)
    const current = asBuilt(stored)
    switch (command) {
      case 'get_layout':
        return describeProject(current)
      case 'screenshot': {
        const bounds = layoutBounds(current)
        if (!bounds) throw new Error('Nothing to draw')
        if (!shown) return screenshotHidden(current.netlist, current.layout, current.settings.isolation, bounds).then((png) => ({ png }))
        const svg = document.querySelector<SVGSVGElement>('svg.canvas')
        if (!svg) throw new Error('Nothing to draw')
        return canvasToPng(svg, bounds).then((png) => ({ png }))
      }
      case 'undo':
      case 'redo':
        if (!shown) return undoHiddenTab(targetId, stored, command)
        if (command === 'undo') undo()
        else redo()
        return { problems: findProblems(asBuilt(projectRef.current)) }
    }
    const next = agentLayoutEdit(command, args, current, stored.netlist)
    if (!shown) return editHiddenTab(targetId, stored, next)
    if (command === 'run_optimizer') setFitRequest((n) => n + 1)
    return applyAgentEdit(next)
  }

  useEffect(
    () => connectAgentBridge((command, args) => handleAgentCommand.current(command, args), setAgentConnected),
    [],
  )

  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  // The agent only talks to the most recently opened browser tab; other browser tabs showing the
  // same project follow along through storage. Writing an unchanged value fires no event, so
  // browser tabs do not echo each other.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === TABS_KEY) {
        const stored = parseStoredTabs(e.newValue)
        if (stored.length > 0) setTabs(stored)
        return
      }
      if (e.key !== projectKey(activeIdRef.current) || !e.newValue) return
      try {
        const stored = parseStoredProject(e.newValue)
        if (!stored) return
        projectRef.current = stored
        setProject(stored)
      } catch {
        // Half-written or foreign data; the next change will bring a good copy.
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => writeProject(activeId, project), 300)
    return () => clearTimeout(timer)
  }, [project, activeId])

  // The tab shows the project name, which changes when a netlist is imported.
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab || tab.name === project.name) return
    const renamed = tabs.map((t) => (t.id === activeId ? { ...t, name: project.name } : t))
    setTabs(renamed)
    writeTabs(renamed)
  }, [project.name, activeId, tabs])

  /** Saves the shown project and its undo history, then shows `id` with its own. */
  const showTab = (id: string, next: Project) => {
    writeProject(activeId, projectRef.current)
    parkedHistory.current.set(activeId, { undo: undoStack.current, redo: redoStack.current })
    const history = parkedHistory.current.get(id)
    undoStack.current = history?.undo ?? []
    redoStack.current = history?.redo ?? []
    parkedHistory.current.delete(id)
    projectRef.current = next
    setProject(next)
    setActiveId(id)
    rememberActiveTab(id)
    setSelection(null)
    setError('')
    setFitRequest((n) => n + 1)
  }

  const switchTab = (id: string) => {
    if (id !== activeId) showTab(id, readProject(id))
  }

  const openInNewTab = (opened: Project) => {
    const id = newTabId()
    writeProject(id, opened)
    const next = [...tabs, { id, name: opened.name }]
    setTabs(next)
    writeTabs(next)
    showTab(id, opened)
  }

  const addTab = () => openInNewTab(emptyProject(project.settings))

  const closeTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id)
    if (!tab || !confirm(`Close "${tab.name}"? Its layout is deleted (it cannot be undone).`)) return
    const remaining = tabs.filter((t) => t.id !== id)
    if (remaining.length === 0) {
      // Always keep one tab: closing the last one leaves a fresh, empty project.
      const created = emptyProject(project.settings)
      writeProject(id, created)
      const fresh = [{ id, name: created.name }]
      setTabs(fresh)
      writeTabs(fresh)
      undoStack.current = []
      redoStack.current = []
      projectRef.current = created
      setProject(created)
      setSelection(null)
      return
    }
    setTabs(remaining)
    writeTabs(remaining)
    if (id === activeId) {
      const neighbour = remaining[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]
      showTab(neighbour.id, readProject(neighbour.id))
    }
    parkedHistory.current.delete(id)
    removeProject(id)
  }

  const setLayers = (next: Layers) => {
    setLayersState(next)
    try {
      localStorage.setItem(LAYERS_KEY, JSON.stringify(next))
    } catch {
      // Storage disabled; the toggle still works for this session.
    }
  }

  const setLayout = (update: (layout: Layout) => Layout) =>
    setProject((p) => ({ ...p, layout: update(p.layout) }))

  const setSettings = (changes: Partial<Settings>) =>
    setProject((p) => ({ ...p, settings: { ...p.settings, ...changes } }))

  const spacingViolations = useMemo(
    () => findSpacingViolations(layout.islands),
    [layout.islands],
  )
  const splitNets = useMemo(() => findSplitNets(layout.islands), [layout.islands])
  const problemNets = useMemo(() => new Set([...spacingViolations, ...splitNets]), [spacingViolations, splitNets])

  const pinCounts = useMemo(() => {
    const counts = { open: 0, short: 0, refsWithIssues: new Set<string>() }
    const components = new Map(builtNetlist.components.map((c) => [c.ref, c]))
    for (const placement of layout.placements) {
      const component = components.get(placement.ref)
      if (!component) continue
      for (const lead of analyzeLeads(component, placement, layout.islands, settings.isolation)) {
        if (lead.status === 'open') counts.open++
        if (lead.status === 'short') counts.short++
        if (lead.status === 'open' || lead.status === 'short') counts.refsWithIssues.add(component.ref)
      }
    }
    return counts
  }, [builtNetlist, layout, settings.isolation])

  const boardSize = useMemo(() => boundsOf(layout.islands.flatMap((i) => i.rects)), [layout.islands])

  const loadNetlist = (name: string, text: string, keepLayout: boolean) => {
    try {
      setProject((p) => projectFromNetlist(name, text, p, keepLayout))
      // Old layouts belong to the old netlist.
      undoStack.current = []
      redoStack.current = []
      setSelection(null)
      setError('')
      setFitRequest((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return
    const keepLayout = confirm('Keep the current positions of matching nets and components?\n\nOK = keep, Cancel = fresh grid')
    loadNetlist(file.name.replace(/\.[^.]+$/, ''), await file.text(), keepLayout)
    fileInputRef.current!.value = ''
  }

  // Rotate and reset leads act on every selected part, each in place.
  const refsToEdit = selectedRefs(selection)

  const rotateSelected = (degrees: number) => {
    if (refsToEdit.length === 0) return
    rememberLayout()
    setLayout((l) => ({
      ...l,
      placements: l.placements.map((p) => (refsToEdit.includes(p.ref) ? { ...p, rotation: (p.rotation + degrees) % 360 } : p)),
    }))
  }

  const resetLeads = () => {
    if (refsToEdit.length === 0) return
    rememberLayout()
    setLayout((l) => ({
      ...l,
      placements: l.placements.map((p) => (refsToEdit.includes(p.ref) ? { ...p, leads: undefined } : p)),
    }))
  }

  const changePlacement = (ref: string, changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) => {
    rememberLayout()
    setLayout((l) => ({ ...l, placements: l.placements.map((p) => (p.ref === ref ? { ...p, ...changes } : p)) }))
  }

  const selectAll = () =>
    setSelection(selectionOf(layout.placements.map((p) => p.ref), layout.islands.map((i) => i.net)))

  const addRect = () => {
    if (selection?.kind !== 'island') return
    const island = layout.islands.find((i) => i.net === selection.net)!
    const base = island.rects[selection.rectIndex] ?? island.rects[0]
    const added = { x: base.x + base.w, y: base.y, w: 4, h: base.h }
    rememberLayout()
    setLayout((l) => ({
      ...l,
      islands: l.islands.map((i) => (i.net === selection.net ? { ...i, rects: [...i.rects, added] } : i)),
    }))
    setSelection({ ...selection, rectIndex: island.rects.length })
  }

  const selectedIsland = selection?.kind === 'island' ? layout.islands.find((i) => i.net === selection.net) : undefined
  const canRemoveRect = selectedIsland !== undefined && selectedIsland.rects.length > 1

  const removeRect = () => {
    if (selection?.kind !== 'island' || !canRemoveRect) return
    rememberLayout()
    setLayout((l) => ({
      ...l,
      islands: l.islands.map((i) =>
        i.net === selection.net ? { ...i, rects: i.rects.filter((_, k) => k !== selection.rectIndex) } : i,
      ),
    }))
    setSelection({ ...selection, rectIndex: 0 })
  }

  const resetToGrid = () => {
    if (!confirm('Discard all manual placement and put everything back on a grid?')) return
    rememberLayout()
    setProject((p) => {
      const grid = createLayout(withFootprintChoices(p.netlist, p.layout.placements))
      return { ...p, layout: keepFootprintChoices(grid, p.layout) }
    })
    setSelection(null)
    setFitRequest((n) => n + 1)
  }

  const openFootprintDialog = () => setFootprintDialogRefs(selectedRefs(selection))

  const applyFootprint = (refs: ReadonlySet<string>, footprint: string | undefined) => {
    rememberLayout()
    setLayout((l) => changeFootprints(netlist, l, refs, footprint))
  }

  const optimize = () => {
    const strategy = findStrategy(settings.strategy)
    if (!confirm(`Replace the current layout with a new ${strategy.label} layout?`)) return
    let optimized: Layout
    try {
      optimized = strategy.run(builtNetlist, settings)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    rememberLayout()
    setProject((p) => ({ ...p, layout: keepFootprintChoices(optimized, p.layout) }))
    setSelection(null)
    setFitRequest((n) => n + 1)
  }

  const exportLayout = () =>
    downloadText(`${project.name}-isolation.svg`, exportSvg(layout.islands, settings.isolation), 'image/svg+xml')

  const exportLayoutDxf = () => downloadText(`${project.name}-isolation.dxf`, exportDxf(layout.islands, settings.isolation), 'application/dxf')

  const saveProject = () => downloadText(`${project.name}.manhattan.json`, projectToFile(project), 'application/json')

  const onProjectFileChosen = async (file: File | undefined) => {
    if (!file) return
    projectFileInputRef.current!.value = ''
    try {
      openInNewTab(projectFromFile(await file.text()))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Keyboard shortcuts; handlers are recreated each render so they always see current state.
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {})
  shortcuts.current = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
    // An open dialog handles its own keys (Escape closes it); the canvas shortcuts stay out of the way.
    if (e.target instanceof Element && e.target.closest('dialog')) return
    const command = e.ctrlKey || e.metaKey
    if (command && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (command && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      redo()
    } else if (command && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      selectAll()
    } else if (command) return
    else if (e.key === 'r' || e.key === 'R') rotateSelected(e.shiftKey ? 15 : 90)
    else if (e.key === 'Delete' || e.key === 'Backspace') removeRect()
    else if (e.key === 'Escape') setSelection(null)
    else if (e.key === 'f' || e.key === 'F') setFitRequest((n) => n + 1)
    else if (e.key === 'v' || e.key === 'V') setTool('select')
    else if (e.key === 'h' || e.key === 'H') setTool('pan')
    else if (e.key === 'm' || e.key === 'M') setMoveMode((mode) => (mode === 'part' ? 'body' : 'part'))
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => shortcuts.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-icon"><Icon name="app" /></span>
          Manhattan Layout Editor
        </div>
        <div className="project-tabs" role="tablist">
          {tabs.map((tab) => (
            <div key={tab.id} className={tab.id === activeId ? 'project-tab active' : 'project-tab'}>
              <button
                role="tab"
                aria-selected={tab.id === activeId}
                className="tab-name"
                onClick={() => switchTab(tab.id)}
                title={tab.name}
              >
                <Icon name="file" />
                <span>{tab.name}</span>
              </button>
              <button className="tab-close" onClick={() => closeTab(tab.id)} title="Close project" aria-label={`Close ${tab.name}`}>
                ✕
              </button>
            </div>
          ))}
          <button className="icon-button" onClick={addTab} title="Open a new project in a new tab" aria-label="New project tab">
            <Icon name="plus" />
          </button>
        </div>
        <div className="header-actions">
          <div className="button-group">
            <button className="icon-button" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
            <button className="icon-button" onClick={redo} title="Redo (Ctrl+Y or Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" /></button>
          </div>
          <span className="separator" />
          <select
            value={settings.strategy}
            onChange={(e) => setSettings({ strategy: e.target.value })}
            title={findStrategy(settings.strategy).description}
            aria-label="Optimizer strategy"
          >
            {STRATEGIES.map((s) => (
              <option key={s.id} value={s.id} title={s.description}>{s.label}</option>
            ))}
          </select>
          <button className="header-button" onClick={optimize} title={findStrategy(settings.strategy).description}>
            <Icon name="optimize" />Optimize
          </button>
          <button className="header-button" onClick={() => setShowAiHelp(true)} title="Let an AI assistant edit this layout (MCP)">
            <Icon name="ai" />AI
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <Section title="File">
            <div className="action-list">
              <button onClick={() => projectFileInputRef.current!.click()} title="Open a saved project in a new tab">
                <Icon name="open" />Open project…
              </button>
              <input
                ref={projectFileInputRef}
                type="file"
                accept=".json"
                hidden
                onChange={(e) => onProjectFileChosen(e.target.files?.[0])}
              />
              <button onClick={saveProject} title="Download this tab's project as a JSON file">
                <Icon name="save" />Save project…
              </button>
              <button onClick={() => fileInputRef.current!.click()}><Icon name="file" />Import netlist…</button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".tel,.enet,.json,.net,.txt"
                hidden
                onChange={(e) => onFileChosen(e.target.files?.[0])}
              />
              <button onClick={resetToGrid}><Icon name="grid" />Reset to grid</button>
              <button onClick={exportLayout} title="Cut paths with stroke width = isolation"><Icon name="export" />Export SVG</button>
              <button onClick={exportLayoutDxf} title="Area to burn as closed contours in mm (board outline + copper as holes), ready to hatch in EzCad">
                <Icon name="export" />Export DXF
              </button>
            </div>
          </Section>
          <Section title="Layers">
            <LayerToggles layers={layers} onChange={setLayers} />
          </Section>
          <Section title={`Components (${builtNetlist.components.length})`} fill>
            <ComponentList
              netlist={builtNetlist}
              selection={selection}
              onSelect={setSelection}
              refsWithIssues={pinCounts.refsWithIssues}
              onChangeFootprint={openFootprintDialog}
            />
          </Section>
        </aside>

        <main className="canvas-area">
          <div className="canvas-toolbar">
            <ToolGroup label="View">
              <button
                className={tool === 'select' ? 'tool active' : 'tool'}
                onClick={() => setTool('select')}
                aria-pressed={tool === 'select'}
                title="Select (V): drag empty space to select, Shift+drag adds"
              >
                <Icon name="select" />Select
              </button>
              <button
                className={tool === 'pan' ? 'tool active' : 'tool'}
                onClick={() => setTool('pan')}
                aria-pressed={tool === 'pan'}
                title="Pan (H): drag empty space to move the view; middle mouse always pans"
              >
                <Icon name="pan" />Pan
              </button>
              <button className="tool" onClick={() => setFitRequest((n) => n + 1)} title="Fit the board in view (F)">
                <Icon name="fit" />Fit
              </button>
            </ToolGroup>
            <ToolGroup label="Component">
              <button className="tool" onClick={() => rotateSelected(90)} disabled={refsToEdit.length === 0} title="R = 90°, Shift+R = 15°">
                <Icon name="rotate" />Rotate
              </button>
              <button className="tool" onClick={resetLeads} disabled={refsToEdit.length === 0} title="Straighten the selected parts' leads">
                <Icon name="leads" />Reset leads
              </button>
              <button className="tool" onClick={openFootprintDialog} disabled={refsToEdit.length === 0} title="Choose another footprint for the selected parts">
                <Icon name="convert" />Footprint…
              </button>
            </ToolGroup>
            <ToolGroup label="Move mode (M)">
              <div className="segmented">
                <button
                  className={moveMode === 'part' ? 'active' : ''}
                  onClick={() => setMoveMode('part')}
                  aria-pressed={moveMode === 'part'}
                  title="Dragging a part takes its bent leads along"
                >
                  With leads
                </button>
                <button
                  className={moveMode === 'body' ? 'active' : ''}
                  onClick={() => setMoveMode('body')}
                  aria-pressed={moveMode === 'body'}
                  title="Dragging a part moves its body; lead ends stay where they are soldered. Shift+drag takes the leads along."
                >
                  Keep connections
                </button>
              </div>
            </ToolGroup>
            <ToolGroup label="Copper">
              <button className="tool" onClick={addRect} disabled={selection?.kind !== 'island'} title="Extend the selected island with a rectangle">
                <Icon name="addRect" />Add rect
              </button>
              <button className="tool" onClick={removeRect} disabled={!canRemoveRect} title="Remove the selected rectangle (Del)">
                <Icon name="removeRect" />Remove rect
              </button>
            </ToolGroup>
          </div>
          <div className="canvas-frame">
            <Canvas
              netlist={builtNetlist}
              layout={layout}
              onLayoutChange={setLayout}
              onBeginEdit={rememberLayout}
              selection={selection}
              onSelect={setSelection}
              snap={settings.snap}
              isolation={settings.isolation}
              problemNets={problemNets}
              fitRequest={fitRequest}
              layers={layers}
              tool={tool}
              moveMode={moveMode}
            />
          </div>
        </main>

        <aside className="sidebar">
          <Section title="Selection">
            <SelectionDetails
              netlist={builtNetlist}
              layout={layout}
              selection={selection}
              onPlacementChange={changePlacement}
              onChangeFootprint={openFootprintDialog}
            />
          </Section>
          <Section title="Board settings">
            <div className="settings">
              <label>
                Snap
                <select value={settings.snap} onChange={(e) => setSettings({ snap: Number(e.target.value) })}>
                  {SNAP_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s === 0 ? 'off' : `${s} mm`}</option>
                  ))}
                </select>
              </label>
              <label>
                Isolation
                <span className="unit-input">
                  <input
                    type="number"
                    min={0.05}
                    step={0.05}
                    value={settings.isolation}
                    onChange={(e) => setSettings({ isolation: Math.max(0.05, Number(e.target.value) || 0.05) })}
                  />
                  mm
                </span>
              </label>
              <label title="Free space the optimizer keeps around each component, for soldering and probing">
                Clearance
                <span className="unit-input">
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={settings.clearance}
                    onChange={(e) => setSettings({ clearance: Math.max(0, Number(e.target.value) || 0) })}
                  />
                  mm
                </span>
              </label>
              <label title="Longest lead the optimizer bends without a heavy penalty">
                Max lead
                <span className="unit-input">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={settings.maxLead}
                    onChange={(e) => setSettings({ maxLead: Math.max(1, Number(e.target.value) || 1) })}
                  />
                  mm
                </span>
              </label>
            </div>
          </Section>
          <Section title="Netlist validation">
            <Validation
              components={netlist.components.length}
              nets={netlist.nets.length}
              openPins={pinCounts.open}
              shortedPins={pinCounts.short}
              netsTooClose={spacingViolations.size}
              netsSplit={splitNets.size}
            />
          </Section>
        </aside>
      </div>

      <footer className="statusbar">
        <span className={agentConnected ? 'agent connected' : 'agent'} title="AI agent bridge (mcp/server.mjs)">
          {agentConnected ? 'Agent connected' : 'No agent'}
        </span>
        {error ? (
          <span className="error">{error}</span>
        ) : (
          <>
            <span>{project.name}</span>
            <span>{netlist.nets.length} nets</span>
            <span>{netlist.components.length} parts</span>
            {boardSize && <span>Board {boardSize.w.toFixed(1)} × {boardSize.h.toFixed(1)} mm</span>}
          </>
        )}
        <span className="hint">V select / H pan · Shift+click adds · Ctrl+A all · M move part / body only · Shift+drag takes leads along · middle-drag pans · wheel zooms · drag a lead end to bend it · R / Shift+R rotate 90° / 15° · Ctrl+Z undo · Del remove rect · F fit</span>
      </footer>
      {showAiHelp && <AiHelpDialog agentConnected={agentConnected} onClose={() => setShowAiHelp(false)} />}
      {footprintDialogRefs && (
        <FootprintDialog
          built={builtNetlist}
          imported={netlist}
          initialRefs={footprintDialogRefs}
          isolation={settings.isolation}
          onApply={applyFootprint}
          onClose={() => setFootprintDialogRefs(null)}
        />
      )}
    </div>
  )
}
