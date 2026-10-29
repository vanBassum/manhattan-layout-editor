import { useEffect, useMemo, useRef, useState } from 'react'
import { connectAgentBridge } from './agentBridge'
import { applyBatch, describeProject, findProblems, layoutBounds, moveComponent, moveIsland, resetLeads as resetLeadsOf, setIsland, setLeadEnd } from './agentCommands'
import { Canvas } from './Canvas'
import { downloadText, exportSvg } from './exportSvg'
import {
  analyzeLeads,
  chooseResistors,
  createLayout,
  findSpacingViolations,
  findSplitNets,
  hasPlainResistors,
  keepFootprintChoices,
  resistorChoice,
  withFootprintChoices,
  type ResistorChoice,
} from './layout'
import { parseNetlist } from './netlist'
import { findStrategy, STRATEGIES } from './optimize'
import { SAMPLE_NAME, SAMPLE_NETLIST } from './sample'
import { canvasToPng } from './screenshot'
import type { Layout, Project, Selection, Settings } from './types'

// v3: components carry a footprint; bent leads are stored relative to the component.
const STORAGE_KEY = 'manhattan-layout-editor/project-v3'
const DEFAULT_SETTINGS: Settings = { snap: 0.5, isolation: 0.4, strategy: STRATEGIES[0].id, clearance: 3, maxLead: 10 }
const UNDO_LIMIT = 100
const SNAP_OPTIONS = [0, 0.25, 0.5, 1, 1.27, 2.54]

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
    // Corrupt or inaccessible storage: fall back to the sample.
  }
  return projectFromNetlist(SAMPLE_NAME, SAMPLE_NETLIST)
}

export function App() {
  const [project, setProject] = useState<Project>(loadProject)
  const [selection, setSelection] = useState<Selection>(null)
  const [fitRequest, setFitRequest] = useState(1)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const undoStack = useRef<Layout[]>([])
  const redoStack = useRef<Layout[]>([])
  const [agentConnected, setAgentConnected] = useState(false)
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
    const counts = { open: 0, short: 0 }
    const components = new Map(builtNetlist.components.map((c) => [c.ref, c]))
    for (const placement of layout.placements) {
      const component = components.get(placement.ref)
      if (!component) continue
      for (const lead of analyzeLeads(component, placement, layout.islands)) {
        if (lead.status === 'open') counts.open++
        if (lead.status === 'short') counts.short++
      }
    }
    return counts
  }, [builtNetlist, layout])

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

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return
    const keepLayout = confirm('Keep the current positions of matching nets and components?\n\nOK = keep, Cancel = fresh grid')
    loadNetlist(file.name.replace(/\.[^.]+$/, ''), await file.text(), keepLayout)
    fileInputRef.current!.value = ''
  }

  const rotateSelected = (degrees: number) => {
    if (selection?.kind !== 'part') return
    rememberLayout()
    setLayout((l) => ({
      ...l,
      placements: l.placements.map((p) => (p.ref === selection.ref ? { ...p, rotation: (p.rotation + degrees) % 360 } : p)),
    }))
  }

  const resetLeads = () => {
    if (selection?.kind !== 'part') return
    rememberLayout()
    setLayout((l) => ({
      ...l,
      placements: l.placements.map((p) => (p.ref === selection.ref ? { ...p, leads: undefined } : p)),
    }))
  }

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

  const setResistorChoice = (choice: ResistorChoice) => {
    rememberLayout()
    setLayout((l) => chooseResistors(netlist, l, choice))
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
    const command = e.ctrlKey || e.metaKey
    if (command && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (command && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      redo()
    } else if (command) return
    else if (e.key === 'r' || e.key === 'R') rotateSelected(e.shiftKey ? 15 : 90)
    else if (e.key === 'Delete' || e.key === 'Backspace') removeRect()
    else if (e.key === 'Escape') setSelection(null)
    else if (e.key === 'f' || e.key === 'F') setFitRequest((n) => n + 1)
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => shortcuts.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={() => fileInputRef.current!.click()}>Import netlist…</button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".tel,.enet,.json,.net,.txt"
          hidden
          onChange={(e) => onFileChosen(e.target.files?.[0])}
        />
        <button onClick={() => loadNetlist(SAMPLE_NAME, SAMPLE_NETLIST, false)}>Load sample</button>
        <button onClick={resetToGrid}>Reset to grid</button>
        <span className="separator" />
        <button onClick={() => setFitRequest((n) => n + 1)} title="F">Fit</button>
        <button onClick={undo} title="Ctrl+Z">Undo</button>
        <button onClick={redo} title="Ctrl+Y or Ctrl+Shift+Z">Redo</button>
        <span className="separator" />
        <button onClick={() => rotateSelected(90)} disabled={selection?.kind !== 'part'} title="R = 90°, Shift+R = 15°">Rotate</button>
        <button onClick={resetLeads} disabled={selection?.kind !== 'part'} title="Straighten the selected part's leads">
          Reset leads
        </button>
        <button onClick={addRect} disabled={selection?.kind !== 'island'} title="Extend the selected island with a rectangle">
          Add rect
        </button>
        <button onClick={removeRect} disabled={!canRemoveRect} title="Del">Remove rect</button>
        <span className="separator" />
        <label title="Build plain resistors (R1, R2, …) through-hole as in the netlist, or as 1206 chips across an isolation gap">
          Resistors
          <select
            value={resistorChoice(layout)}
            disabled={!hasPlainResistors(netlist)}
            onChange={(e) => setResistorChoice(e.target.value as ResistorChoice)}
          >
            <option value="through-hole">Through-hole</option>
            <option value="1206">1206 SMD</option>
          </select>
        </label>
        <span className="separator" />
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
          <input
            type="number"
            min={0.05}
            step={0.05}
            value={settings.isolation}
            onChange={(e) => setSettings({ isolation: Math.max(0.05, Number(e.target.value) || 0.05) })}
          />
          mm
        </label>
        <span className="separator" />
        <label title="Free space the optimizer keeps around each component, for soldering and probing">
          Clearance
          <input
            type="number"
            min={0}
            step={0.5}
            value={settings.clearance}
            onChange={(e) => setSettings({ clearance: Math.max(0, Number(e.target.value) || 0) })}
          />
          mm
        </label>
        <label title="Longest lead the optimizer bends without a heavy penalty">
          Max lead
          <input
            type="number"
            min={1}
            step={1}
            value={settings.maxLead}
            onChange={(e) => setSettings({ maxLead: Math.max(1, Number(e.target.value) || 1) })}
          />
          mm
        </label>
        <select
          value={settings.strategy}
          onChange={(e) => setSettings({ strategy: e.target.value })}
          title={findStrategy(settings.strategy).description}
        >
          {STRATEGIES.map((s) => (
            <option key={s.id} value={s.id} title={s.description}>{s.label}</option>
          ))}
        </select>
        <button onClick={optimize} title={findStrategy(settings.strategy).description}>Optimize</button>
        <span className="separator" />
        <button onClick={exportLayout}>Export SVG</button>
      </div>

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
      />

      <div className="statusbar">
        {error ? (
          <span className="error">{error}</span>
        ) : (
          <>
            <span>{project.name}</span>
            <span>{netlist.nets.length} nets</span>
            <span>{netlist.components.length} parts</span>
            <span className={pinCounts.open ? 'warn' : ''}>{pinCounts.open} open pins</span>
            <span className={pinCounts.short ? 'error' : ''}>{pinCounts.short} shorted pins</span>
            <span className={spacingViolations.size ? 'error' : ''}>{spacingViolations.size} nets too close</span>
            <span className={splitNets.size ? 'error' : ''} title="Islands in separate pieces need a wire jumper">
              {splitNets.size} nets split
            </span>
            <SelectionInfo project={project} selection={selection} />
          </>
        )}
        <span className={agentConnected ? 'agent connected' : 'agent'} title="AI agent bridge (mcp/server.mjs)">
          {agentConnected ? 'Agent connected' : 'No agent'}
        </span>
        <span className="hint">Drag empty space to pan · wheel zooms · drag a lead end to bend it · R / Shift+R rotate 90° / 15° · Ctrl+Z undo · Del remove rect · F fit</span>
      </div>
    </div>
  )
}

function SelectionInfo({ project, selection }: { project: Project; selection: Selection }) {
  if (selection?.kind === 'island') {
    const pins = project.netlist.components.flatMap((c) =>
      c.pins.filter((p) => p.net === selection.net).map((p) => `${c.ref}.${p.number}`),
    )
    return <span className="selection">Net {selection.net}: {pins.join(' ')}</span>
  }
  if (selection?.kind === 'part') {
    const component = project.netlist.components.find((c) => c.ref === selection.ref)
    if (!component) return null
    const pins = component.pins.map((p) => `${p.number}:${p.net || '–'}`).join(' ')
    return <span className="selection">{component.ref} {component.value} — {pins}</span>
  }
  return null
}
