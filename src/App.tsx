import { useEffect, useMemo, useRef, useState } from 'react'
import { connectAgentBridge } from './agentBridge'
import { applyBatch, describeProject, findProblems, layoutBounds, moveComponent, moveIsland, resetLeads as resetLeadsOf, setFootprint, setIsland, setLeadEnd } from './agentCommands'
import { Canvas, type LayerName, type Layers, type LayerView, type MoveMode, type Tool } from './Canvas'
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
import { AiHelpDialog, ComponentList, Icon, LayerToggles, Section, SelectionDetails, Validation } from './panels'
import { canvasToPng } from './screenshot'
import { selectedRefs, selectionOf } from './selection'
import type { Layout, Project, Selection, Settings } from './types'

// v3: components carry a footprint; bent leads are stored relative to the component.
const STORAGE_KEY = 'manhattan-layout-editor/project-v3'
const DEFAULT_SETTINGS: Settings = { snap: 0.5, isolation: 0.4, strategy: STRATEGIES[0].id, clearance: 3, maxLead: 10 }
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

const emptyProject = (settings: Settings = DEFAULT_SETTINGS): Project => ({
  name: 'Untitled',
  netlist: { components: [], nets: [] },
  layout: { islands: [], placements: [] },
  settings,
})

function projectFromNetlist(name: string, text: string, previous?: Project): Project {
  const netlist = parseNetlist(text)
  return {
    name,
    netlist,
    layout: createLayout(netlist, previous?.layout),
    settings: previous?.settings ?? DEFAULT_SETTINGS,
  }
}

/** The project with the editor's footprint choices applied: what drawing, checks and optimizers should see. */
const asBuilt = (project: Project): Project => ({
  ...project,
  netlist: withFootprintChoices(project.netlist, project.layout.placements),
})

function parseStoredProject(stored: string): Project | null {
  const project = JSON.parse(stored) as Project
  if (!project.netlist?.components || !project.layout?.islands) return null
  return { ...project, settings: { ...DEFAULT_SETTINGS, ...project.settings } }
}

function loadProject(): Project {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    const project = stored ? parseStoredProject(stored) : null
    if (project) return project
  } catch {
    // Corrupt or inaccessible storage: start empty.
  }
  return emptyProject()
}

export function App() {
  const [project, setProject] = useState<Project>(loadProject)
  const [selection, setSelection] = useState<Selection>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [moveMode, setMoveMode] = useState<MoveMode>('part')
  const [fitRequest, setFitRequest] = useState(1)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const undoStack = useRef<Layout[]>([])
  const redoStack = useRef<Layout[]>([])
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

  const handleAgentCommand = useRef<(command: string, args: Record<string, unknown>) => unknown>(() => undefined)
  handleAgentCommand.current = (command, args) => {
    const current = asBuilt(projectRef.current)
    switch (command) {
      case 'get_layout':
        return describeProject(current)
      case 'screenshot': {
        const svg = document.querySelector<SVGSVGElement>('svg.canvas')
        const bounds = layoutBounds(current)
        if (!svg || !bounds) throw new Error('Nothing to draw')
        return canvasToPng(svg, bounds).then((png) => ({ png }))
      }
      case 'move_component':
        return applyAgentEdit(moveComponent(current, args))
      case 'set_lead_end':
        return applyAgentEdit(setLeadEnd(current, args))
      case 'reset_leads':
        return applyAgentEdit(resetLeadsOf(current, args))
      case 'set_island':
        return applyAgentEdit(setIsland(current, args))
      case 'move_island':
        return applyAgentEdit(moveIsland(current, args))
      case 'batch':
        return applyAgentEdit(applyBatch(current, args))
      case 'run_optimizer': {
        const optimized = findStrategy(String(args.strategy)).run(current.netlist, current.settings)
        const result = applyAgentEdit(keepFootprintChoices(optimized, current.layout))
        setFitRequest((n) => n + 1)
        return result
      }
      case 'set_resistor_footprint': {
        if (args.footprint !== 'through-hole' && args.footprint !== '1206') {
          throw new Error('"footprint" must be "through-hole" or "1206"')
        }
        return applyAgentEdit(chooseResistors(projectRef.current.netlist, current.layout, args.footprint))
      }
      case 'set_footprint':
        return applyAgentEdit(setFootprint(current, projectRef.current.netlist, args))
      case 'undo':
        undo()
        return { problems: findProblems(asBuilt(projectRef.current)) }
      case 'redo':
        redo()
        return { problems: findProblems(asBuilt(projectRef.current)) }
      default:
        throw new Error(`Unknown command "${command}"`)
    }
  }

  useEffect(
    () => connectAgentBridge((command, args) => handleAgentCommand.current(command, args), setAgentConnected),
    [],
  )

  // The agent only talks to the most recently opened tab; other open tabs follow along through
  // storage. Writing an unchanged value fires no event, so tabs do not echo each other.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return
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
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(project))
      } catch {
        // Storage full or disabled; nothing useful to do in a prototype.
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [project])

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
    () => findSpacingViolations(layout.islands, settings.isolation),
    [layout.islands, settings.isolation],
  )
  const splitNets = useMemo(() => findSplitNets(layout.islands), [layout.islands])
  const problemNets = useMemo(() => new Set([...spacingViolations, ...splitNets]), [spacingViolations, splitNets])

  const pinCounts = useMemo(() => {
    const counts = { open: 0, short: 0, refsWithIssues: new Set<string>() }
    const components = new Map(builtNetlist.components.map((c) => [c.ref, c]))
    for (const placement of layout.placements) {
      const component = components.get(placement.ref)
      if (!component) continue
      for (const lead of analyzeLeads(component, placement, layout.islands)) {
        if (lead.status === 'open') counts.open++
        if (lead.status === 'short') counts.short++
        if (lead.status === 'open' || lead.status === 'short') counts.refsWithIssues.add(component.ref)
      }
    }
    return counts
  }, [builtNetlist, layout])

  const boardSize = useMemo(() => boundsOf(layout.islands.flatMap((i) => i.rects)), [layout.islands])

  const loadNetlist = (name: string, text: string, keepLayout: boolean) => {
    try {
      setProject((p) => projectFromNetlist(name, text, keepLayout ? p : undefined))
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

  const newProject = () => {
    if (!confirm('Start a new, empty project? The current layout is discarded (it cannot be undone).')) return
    setProject((p) => emptyProject(p.settings))
    undoStack.current = []
    redoStack.current = []
    setSelection(null)
    setError('')
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
        <div className="project-tab" title={project.name}>{project.name}</div>
        <button className="icon-button" onClick={newProject} title="New empty project" aria-label="New empty project">
          <Icon name="plus" />
        </button>
        <div className="header-actions">
          <button className="icon-button" onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" /></button>
          <button className="icon-button" onClick={redo} title="Redo (Ctrl+Y or Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <Section title="File">
            <div className="action-list">
              <button onClick={() => fileInputRef.current!.click()}><Icon name="file" />Import netlist…</button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".tel,.enet,.json,.net,.txt"
                hidden
                onChange={(e) => onFileChosen(e.target.files?.[0])}
              />
              <button onClick={resetToGrid}><Icon name="grid" />Reset to grid</button>
              <button onClick={exportLayout}><Icon name="export" />Export SVG</button>
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
            <button
              className={tool === 'select' ? 'pill active' : 'pill'}
              onClick={() => setTool('select')}
              aria-pressed={tool === 'select'}
              title="Select (V): drag empty space to select, Shift+drag adds"
            >
              <Icon name="select" />Select
            </button>
            <button
              className={tool === 'pan' ? 'pill active' : 'pill'}
              onClick={() => setTool('pan')}
              aria-pressed={tool === 'pan'}
              title="Pan (H): drag empty space to move the view; middle mouse always pans"
            >
              <Icon name="pan" />Pan
            </button>
            <span className="separator" />
            <button
              className={moveMode === 'part' ? 'pill active' : 'pill'}
              onClick={() => setMoveMode('part')}
              aria-pressed={moveMode === 'part'}
              title="Move part (M toggles): dragging a part takes its bent leads along"
            >
              <Icon name="movePart" />Move part
            </button>
            <button
              className={moveMode === 'body' ? 'pill active' : 'pill'}
              onClick={() => setMoveMode('body')}
              aria-pressed={moveMode === 'body'}
              title="Body only (M toggles): dragging a part moves its body; lead ends stay where they are soldered"
            >
              <Icon name="moveBody" />Body only
            </button>
            <span className="separator" />
            <button className="pill" onClick={() => setFitRequest((n) => n + 1)} title="F"><Icon name="fit" />Fit</button>
            <span className="separator" />
            <button className="pill" onClick={() => rotateSelected(90)} disabled={refsToEdit.length === 0} title="R = 90°, Shift+R = 15°">
              <Icon name="rotate" />Rotate
            </button>
            <button className="pill" onClick={resetLeads} disabled={refsToEdit.length === 0} title="Straighten the selected parts' leads">
              <Icon name="leads" />Reset leads
            </button>
            <span className="separator" />
            <button className="pill" onClick={addRect} disabled={selection?.kind !== 'island'} title="Extend the selected island with a rectangle">
              <Icon name="addRect" />Add rect
            </button>
            <button className="pill" onClick={removeRect} disabled={!canRemoveRect} title="Del">
              <Icon name="removeRect" />Remove rect
            </button>
            <span className="separator" />
            <select
              className="pill"
              value={settings.strategy}
              onChange={(e) => setSettings({ strategy: e.target.value })}
              title={findStrategy(settings.strategy).description}
            >
              {STRATEGIES.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>{s.label}</option>
              ))}
            </select>
            <button className="pill primary" onClick={optimize} title={findStrategy(settings.strategy).description}>
              <Icon name="optimize" />Optimize
            </button>
            <button className="pill" onClick={() => setShowAiHelp(true)} title="Let an AI assistant edit this layout (MCP)">
              <Icon name="ai" />AI
            </button>
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
            <SelectionDetails netlist={builtNetlist} selection={selection} />
            <div className="action-list selection-actions">
              <button onClick={openFootprintDialog} disabled={refsToEdit.length === 0} title="Choose another footprint for the selected parts">
                <Icon name="convert" />Change footprint…
              </button>
            </div>
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
        <span className="hint">V select / H pan · Shift+click adds · Ctrl+A all · M move part / body only · middle-drag pans · wheel zooms · drag a lead end to bend it · R / Shift+R rotate 90° / 15° · Ctrl+Z undo · Del remove rect · F fit</span>
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
