import { useEffect, useMemo, useRef, useState } from 'react'
import { connectAgentBridge } from './agentBridge'
import { buildNetlist, checkedDefinition, withAssignedDefinition, withDefinitions } from './definitions'
import { applyBatch, describeProject, findProblems, layoutBounds, moveComponent, moveIsland, resetLeads as resetLeadsOf, setFootprint, setIsland, setLeadEnd } from './agentCommands'
import { Canvas, type EditMode, type LayerName, type Layers, type LayerView, type MoveMode, type Tool } from './Canvas'
import { exportDxf } from './exportDxf'
import { downloadText, exportSvg } from './exportSvg'
import { FootprintDialog } from './FootprintDialog'
import { boundsOf } from './geometry'
import {
  analyzeLeads,
  changeFootprints,
  chooseResistors,
  createLayout,
  followNetlist,
  findSpacingViolations,
  findSplitNets,
  keepFootprintChoices,
} from './layout'
import { parseNetlist, withValues } from './netlist'
import { findStrategy, STRATEGIES } from './optimize'
import {
  AiHelpDialog,
  ComponentList,
  HelpDialog,
  Icon,
  LayerToggles,
  PartProperties,
  SaveChangesDialog,
  SchematicCheck,
  SchematicLayerToggles,
  Section,
  SelectionDetails,
  Validation,
  ViewMenu,
  type SaveChoice,
} from './panels'
import { canUseFiles, fileLabel, mayUse, pickFileToOpen, pickFileToSave, readFile, writeFile } from './projectFiles'
import {
  acceptFileContent,
  addProject,
  DEFAULT_SETTINGS,
  emptyProject,
  EXAMPLES,
  loadTabs,
  markSaved,
  newTabId,
  onFileChange,
  onRemoteChange,
  projectFile,
  projectFromFile,
  projectToFile,
  readProject,
  rememberActiveTab,
  removeProject,
  unlinkFile,
  writeProject,
  writeTabs,
  type ProjectTab,
} from './projectStore'
import { canvasToPng } from './screenshot'
import { selectedRefs, selectionOf } from './selection'
import { screenshotHidden } from './hiddenScreenshot'
import {
  agentPlacements,
  completeSchematic,
  deriveNets,
  flipped,
  labelsFromAgent,
  pinEnds,
  pinsWithOtherNet,
  wiresFromPolylines,
  withPlacementChanges,
  type FullSchematic,
} from './schematic'
import { SchematicView, type SchematicLayer, type SchematicLayers, type SchematicTool } from './SchematicView'
import type { Layout, Netlist, Placement, Project, Selection, Settings } from './types'
import type { IconName } from './panels'
import { ProjectTabs } from './ProjectTabs'
import { NO_HISTORY, snapshotOf, stepHistory, withEdit, type History, type Snapshot } from './undoHistory'

/** Which views are shown: one of them, or both side by side. */
type ViewMode = 'schematic' | 'split' | 'layout'
type Pane = 'schematic' | 'layout'

const SCHEMATIC_TOOLS: { id: SchematicTool; icon: IconName; label: string; title: string }[] = [
  {
    id: 'select',
    icon: 'select',
    label: 'Select',
    title:
      'Select (V): drag parts; drag empty space to select, Shift+click or Shift+drag adds. ' +
      'Drag from a pin end to draw a wire (Shift: from a wire end). Drag a wire end to move it, ' +
      'a wire sideways to shift it. Click a wire or label and press Del to remove it',
  },
  {
    id: 'wire',
    icon: 'wire',
    label: 'Wire',
    title:
      'Wire (W): drag for one wire, or click corner by corner and double-click or Esc to stop. Space flips the bend. ' +
      'Ending on a pin, a wire end or the middle of a wire connects; crossing wires do not',
  },
  { id: 'label', icon: 'label', label: 'Label', title: 'Label (L): click a point to name its net; labels with the same name are connected. Double-click a label to rename it' },
]

const SNAP_OPTIONS = [0, 0.25, 0.5, 1, 1.27, 2.54]
// Layer visibility is a per-browser view preference, deliberately not part of the project.
const LAYERS_KEY = 'manhattan-layout-editor/layers'
const SCHEMATIC_LAYERS_KEY = 'manhattan-layout-editor/schematic-layers'
const THEME_KEY = 'manhattan-layout-editor/theme'
const VIEW_KEY = 'manhattan-layout-editor/view'

// Storage can be disabled (private window, blocked site data); preferences then last one session.
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function initialView(): ViewMode {
  const stored = readPreference(VIEW_KEY)
  if (stored === 'schematic' || stored === 'split' || stored === 'layout') return stored
  return 'layout'
}

type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const stored = readPreference(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
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
  const stored = readPreference(LAYERS_KEY)
  if (!stored) return ALL_LAYERS
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const layers = { ...ALL_LAYERS }
    for (const layer of Object.keys(layers) as LayerName[]) layers[layer] = parseLayerView(parsed[layer])
    return layers
  } catch {
    return ALL_LAYERS
  }
}

const ALL_SCHEMATIC_LAYERS: SchematicLayers = { grid: true, references: true, values: true, pinNumbers: true }

function loadSchematicLayers(): SchematicLayers {
  const stored = readPreference(SCHEMATIC_LAYERS_KEY)
  if (!stored) return ALL_SCHEMATIC_LAYERS
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const layers = { ...ALL_SCHEMATIC_LAYERS }
    for (const layer of Object.keys(layers) as SchematicLayer[]) layers[layer] = parsed[layer] !== false
    return layers
  } catch {
    return ALL_SCHEMATIC_LAYERS
  }
}

/** The tab's project with a new netlist; it stays the same project, so it keeps its guid. */
function projectFromNetlist(name: string, text: string, current: Project, keepLayout: boolean): Project {
  const imported = parseNetlist(text)
  // A value typed in the editor survives a re-import that still has none (EasyEDA exports "{Value}"
  // as empty), and so does the part's definition; withDefinitions drops one that no longer fits.
  const previous = new Map(current.netlist.components.map((c) => [c.ref, c]))
  const netlist = keepLayout
    ? {
        ...imported,
        components: imported.components.map((c) => ({
          ...c,
          value: c.value || previous.get(c.ref)?.value || '',
          definition: previous.get(c.ref)?.definition,
        })),
      }
    : imported
  return withDefinitions({
    guid: current.guid,
    name,
    netlist,
    layout: createLayout(netlist, keepLayout ? current.layout : undefined),
    // Symbols stay where they were; wires and labels start over from the imported nets.
    schematic: keepLayout && current.schematic ? { placements: current.schematic.placements } : undefined,
    definitions: keepLayout ? current.definitions : undefined,
    settings: keepLayout ? current.settings : DEFAULT_SETTINGS,
  })
}

/** The project's schematic with every part placed; `project` is as stored, without footprint choices applied. */
const fullSchematicOf = (project: Project): FullSchematic =>
  completeSchematic(buildNetlist(project.netlist, project.layout.placements, project.definitions), project.schematic)

/** The nets the project's schematic gives, which the PCB does not use until it is updated. */
function schematicNetsOf(project: Project) {
  const built = buildNetlist(project.netlist, project.layout.placements, project.definitions)
  return deriveNets(project.netlist, built, fullSchematicOf(project))
}

/** The project with the PCB brought in line with the schematic: its nets, and islands that follow them. */
function withSchematicNets(project: Project): Project {
  const { netlist } = schematicNetsOf(project)
  return { ...project, netlist, layout: followNetlist(project.layout, project.netlist, netlist) }
}

/** What an agent needs to draw wires: every pin end with its schematic net, the wires and labels, shorts, and what the PCB does not have yet. */
function describeSchematic(project: Project) {
  const schematic = fullSchematicOf(project)
  const { netlist, conflicts } = schematicNetsOf(project)
  const built = buildNetlist(netlist, project.layout.placements, project.definitions)
  return {
    units: 'mm; x to the right, y down; grid 2.54',
    parts: built.components.map((component, i) => ({
      value: component.value,
      ...schematic.placements[i],
      pins: pinEnds(component, schematic.placements[i]).map((end, k) => ({
        pin: component.pins[k].number,
        net: component.pins[k].net,
        x: end.x,
        y: end.y,
      })),
    })),
    wires: schematic.wires,
    labels: schematic.labels,
    shorts: conflicts.map((c) => c.names),
    pinsNotInPcb: pinsWithOtherNet(project.netlist, netlist),
  }
}

/** The project with the editor's footprint choices applied: what drawing, checks and optimizers should see. */
const asBuilt = (project: Project): Project => ({
  ...project,
  netlist: buildNetlist(project.netlist, project.layout.placements, project.definitions),
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

export function App() {
  const [initialTabs] = useState(loadTabs)
  const [tabs, setTabs] = useState<ProjectTab[]>(initialTabs.tabs)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [activeId, setActiveId] = useState(initialTabs.activeId)
  const [project, setProject] = useState<Project>(() => readProject(initialTabs.activeId))
  const [selection, setSelection] = useState<Selection>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [moveMode, setMoveMode] = useState<MoveMode>('part')
  const [view, setView] = useState<ViewMode>(initialView)
  /** The pane last clicked in; keyboard shortcuts act on it when both are shown. */
  const [activePane, setActivePane] = useState<Pane>(() => (view === 'schematic' ? 'schematic' : 'layout'))
  const [schematicTool, setSchematicTool] = useState<SchematicTool>('select')
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const fileMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!fileMenuOpen) return
    const closeOutside = (e: PointerEvent) => {
      if (!fileMenuRef.current?.contains(e.target as Node)) setFileMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [fileMenuOpen])
  const showView = (mode: ViewMode) => {
    setView(mode)
    if (mode !== 'split') setActivePane(mode)
    writePreference(VIEW_KEY, mode)
  }
  const [fitRequest, setFitRequest] = useState(1)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const projectFileInputRef = useRef<HTMLInputElement>(null)
  /** Undo history of the shown tab. */
  const history = useRef<History>(NO_HISTORY)
  /** Undo history of the tabs that are not shown, so switching back keeps it. */
  const parkedHistory = useRef(new Map<string, History>())
  const [agentConnected, setAgentConnected] = useState(false)
  const [showAiHelp, setShowAiHelp] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [theme, setTheme] = useState(initialTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    writePreference(THEME_KEY, next)
  }
  /** Parts checked when the footprint dialog opened; null while it is closed. */
  const [footprintDialogRefs, setFootprintDialogRefs] = useState<string[] | null>(null)
  const [layers, setLayersState] = useState<Layers>(loadLayers)
  const [schematicLayers, setSchematicLayersState] = useState<SchematicLayers>(loadSchematicLayers)
  const { netlist, layout, settings } = project
  const builtNetlist = useMemo(() => buildNetlist(netlist, layout.placements, project.definitions), [netlist, layout.placements, project.definitions])
  const fullSchematic = useMemo(() => completeSchematic(builtNetlist, project.schematic), [builtNetlist, project.schematic])
  const schematicNets = useMemo(() => deriveNets(netlist, builtNetlist, fullSchematic), [netlist, builtNetlist, fullSchematic])
  /** The schematic's own nets, drawn in the schematic; the PCB keeps `builtNetlist` until it is updated. */
  const schematicNetlist = useMemo(
    () => buildNetlist(schematicNets.netlist, layout.placements, project.definitions),
    [schematicNets, layout.placements, project.definitions],
  )
  const pinsNotInPcb = useMemo(() => pinsWithOtherNet(netlist, schematicNets.netlist), [netlist, schematicNets])
  const schematicOpenPins = useMemo(
    () => schematicNets.netlist.components.flatMap((c) => c.pins.filter((p) => !p.net).map((p) => `${c.ref}.${p.number}`)),
    [schematicNets],
  )

  // Latest project, also between a change and the next render: agent commands can arrive back to back.
  const projectRef = useRef(project)
  projectRef.current = project
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const restore = (snapshot: Snapshot) => {
    projectRef.current = { ...projectRef.current, ...snapshot }
    setProject(projectRef.current)
  }

  /** Call right before changing the layout or schematic, so the change can be undone. */
  const rememberEdit = () => {
    history.current = withEdit(history.current, snapshotOf(projectRef.current))
  }

  const stepShownTab = (direction: 'undo' | 'redo') => {
    const stepped = stepHistory(history.current, snapshotOf(projectRef.current), direction)
    if (!stepped) return
    history.current = stepped.history
    restore(stepped.restored)
    setSelection(null)
  }
  const undo = () => stepShownTab('undo')
  const redo = () => stepShownTab('redo')

  /** The tab an agent command is for: its "project" argument (tab id or name), else the shown tab. */
  const agentTarget = (project: unknown): string => {
    if (project === undefined || project === '') return activeIdRef.current
    const tabs = tabsRef.current
    const wanted = String(project)
    const byId = tabs.find((t) => t.id === wanted)
    if (byId) return byId.id
    const byName = tabs.filter((t) => t.name.toLowerCase() === wanted.toLowerCase())
    if (byName.length === 1) return byName[0].id
    const known = tabs.map((t) => `${t.name} (${t.id})`).join(', ')
    throw new Error(`${byName.length > 1 ? 'Several' : 'No'} projects named "${wanted}"; use the id. Open: ${known}`)
  }

  /** Undo or redo on a tab that is not shown: straight in storage, with its own history. Returns the tab's project. */
  const stepHiddenTab = (id: string, stored: Project, direction: 'undo' | 'redo'): Project => {
    const stepped = stepHistory(parkedHistory.current.get(id) ?? NO_HISTORY, snapshotOf(stored), direction)
    if (!stepped) return stored
    parkedHistory.current.set(id, stepped.history)
    const updated = { ...stored, ...stepped.restored }
    writeProject(id, updated)
    return updated
  }

  /** An undoable agent change to the shown tab or a hidden one. Returns the changed project. */
  const applyAgentChange = (id: string, stored: Project, changes: Partial<Snapshot>): Project => {
    if (id === activeIdRef.current) {
      rememberEdit()
      restore({ ...snapshotOf(projectRef.current), ...changes })
      return projectRef.current
    }
    parkedHistory.current.set(id, withEdit(parkedHistory.current.get(id) ?? NO_HISTORY, snapshotOf(stored)))
    const updated = { ...stored, ...changes }
    writeProject(id, updated)
    return updated
  }

  const handleAgentCommand = useRef<(command: string, args: Record<string, unknown>) => unknown>(() => undefined)
  handleAgentCommand.current = (command, args) => {
    if (command === 'list_projects') {
      return { projects: tabsRef.current.map((t) => ({ id: t.id, name: t.name, shown: t.id === activeIdRef.current })) }
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
        // The layout is not on screen for another tab, or while only the schematic is shown.
        const svg = shown ? document.querySelector<SVGSVGElement>('svg.canvas') : null
        if (!svg) return screenshotHidden(current.netlist, current.layout, current.settings.isolation, bounds).then((png) => ({ png }))
        return canvasToPng(svg, bounds).then((png) => ({ png }))
      }
      case 'undo':
      case 'redo': {
        if (!shown) return { problems: findProblems(asBuilt(stepHiddenTab(targetId, stored, command))) }
        stepShownTab(command)
        return { problems: findProblems(asBuilt(projectRef.current)) }
      }
      case 'get_schematic':
        return describeSchematic(stored)
      case 'set_schematic':
      case 'set_wires':
      case 'set_labels': {
        const schematic = fullSchematicOf(stored)
        const next =
          command === 'set_wires'
            ? { ...schematic, wires: wiresFromPolylines(args.wires) }
            : command === 'set_labels'
              ? { ...schematic, labels: labelsFromAgent(args.labels) }
              : withPlacementChanges(schematic, current.netlist, agentPlacements(stored.netlist, args.placements))
        applyAgentChange(targetId, stored, { schematic: next })
        return describeSchematic({ ...stored, schematic: next })
      }
      case 'update_pcb': {
        const updated = applyAgentChange(targetId, stored, snapshotOf(withSchematicNets(stored)))
        return { problems: findProblems(asBuilt(updated)) }
      }
      case 'get_definitions':
        return {
          definitions: stored.definitions ?? {},
          parts: stored.netlist.components.map((c) => ({ ref: c.ref, value: c.value, definition: c.definition, footprint: c.footprint })),
        }
      case 'set_definition': {
        const id = String(args.id ?? '')
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('"id" must be lowercase letters, digits and dashes, e.g. "lm1875"')
        const definitions = { ...stored.definitions, [id]: checkedDefinition(args.definition) }
        applyAgentChange(targetId, stored, { definitions })
        return { id, definitions: Object.keys(definitions) }
      }
      case 'assign_definition': {
        const netlist = withAssignedDefinition(stored.netlist, stored.definitions, args.refs, args.definition)
        applyAgentChange(targetId, stored, { netlist })
        return { parts: netlist.components.map((c) => ({ ref: c.ref, definition: c.definition })) }
      }
      case 'set_values': {
        const netlist = withValues(stored.netlist, args.values)
        applyAgentChange(targetId, stored, { netlist })
        return { components: netlist.components.map((c) => ({ ref: c.ref, value: c.value })) }
      }
    }
    const updated = applyAgentChange(targetId, stored, { layout: agentLayoutEdit(command, args, current, stored.netlist) })
    if (shown && command === 'run_optimizer') setFitRequest((n) => n + 1)
    return { problems: findProblems(asBuilt(updated)) }
  }

  useEffect(
    () => connectAgentBridge((command, args) => handleAgentCommand.current(command, args), setAgentConnected),
    [],
  )

  // The agent only talks to the most recently opened browser tab; other browser tabs showing the
  // same project follow along. The store skips writes that change nothing, so browser tabs do not
  // echo each other.
  useEffect(
    () =>
      onRemoteChange((change) => {
        if (change.kind === 'tabs') {
          if (change.tabs.length > 0) setTabs(change.tabs)
        } else if (change.id === activeIdRef.current) {
          projectRef.current = change.project
          setProject(change.project)
        }
      }),
    [],
  )

  // Re-render when a tab gets or loses unsaved changes, or its file is checked.
  const [, setFileStatusVersion] = useState(0)
  useEffect(() => onFileChange(() => setFileStatusVersion((n) => n + 1)), [])

  useEffect(() => {
    const timer = setTimeout(() => writeProject(activeId, project), 300)
    return () => clearTimeout(timer)
  }, [project, activeId])

  // The last change may still wait for the timer above.
  useEffect(() => {
    const flush = () => writeProject(activeIdRef.current, projectRef.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

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
    parkedHistory.current.set(activeId, history.current)
    history.current = parkedHistory.current.get(id) ?? NO_HISTORY
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

  const openInNewTab = (opened: Project, handle?: FileSystemFileHandle) => {
    const id = newTabId()
    addProject(id, opened, handle)
    const next = [...tabs, { id, name: opened.name }]
    setTabs(next)
    writeTabs(next)
    showTab(id, opened)
  }

  const newProject = () => openInNewTab(emptyProject(project.settings))

  /** The project of tab `id`, including changes still waiting to be written to the recovery copy. */
  const shownProject = (id: string) => (id === activeIdRef.current ? projectRef.current : readProject(id))

  /**
   * The file's project and its content as the editor would save it, so it compares with what the
   * editor saved even when the file came from an older version; `project` is null when unreadable.
   */
  const readProjectFile = async (handle: FileSystemFileHandle) => {
    const text = await readFile(handle)
    try {
      const fromFile = projectFromFile(text)
      return { project: fromFile, content: projectToFile(fromFile) }
    } catch {
      return { project: null, content: text }
    }
  }

  /** Saves tab `id` to its file, or asks for one; false when nothing was saved. */
  const saveTab = async (id: string, saveAs = false): Promise<boolean> => {
    const toSave = shownProject(id)
    const content = projectToFile(toSave)
    try {
      if (!canUseFiles) {
        downloadText(`${toSave.name}.manhattan.json`, content, 'application/json')
        markSaved(id, toSave)
        return true
      }
      const file = projectFile(id)
      let handle = saveAs ? undefined : file.handle
      if (handle) {
        if (!(await mayUse(handle, true))) return false
        const onDisk = await readProjectFile(handle).catch(() => null)
        const changedOnDisk = onDisk !== null && onDisk.content !== file.savedContent
        if (changedOnDisk && !confirm(`"${handle.name}" changed on disk since it was opened or saved here. Overwrite it?`)) return false
      } else {
        handle = (await pickFileToSave(`${toSave.name}.manhattan.json`)) ?? undefined
        if (!handle) return false
      }
      await writeFile(handle, content)
      markSaved(id, toSave, handle)
      return true
    } catch (e) {
      setError(`Could not save: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  const openProjectFile = async () => {
    if (!canUseFiles) {
      projectFileInputRef.current!.click()
      return
    }
    try {
      const handle = await pickFileToOpen()
      if (!handle) return
      for (const tab of tabs) {
        const open = projectFile(tab.id).handle
        if (open && (await open.isSameEntry(handle))) return switchTab(tab.id)
      }
      openInNewTab(projectFromFile(await readFile(handle)), handle)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * After a reload the tab shows its recovery copy. Compares the file with it: an unchanged file
   * needs nothing, a file changed elsewhere replaces a copy without unsaved changes, and with
   * changes on both sides the user picks. Without permission yet (`ask` false) it waits for a click.
   */
  const [fileConflict, setFileConflict] = useState<{ id: string; project: Project; content: string } | null>(null)
  const checkFile = async (id: string, ask: boolean) => {
    const file = projectFile(id)
    if (!file.handle || file.checked) return
    try {
      if (!(await mayUse(file.handle, ask))) return
      const onDisk = await readProjectFile(file.handle)
      if (id !== activeIdRef.current) return
      if (onDisk.content === file.savedContent) acceptFileContent(id, onDisk.content)
      else if (!onDisk.project) throw new Error('it is not a Manhattan project anymore')
      else if (!file.dirty) loadFileVersion(id, onDisk.project, file.handle)
      else setFileConflict({ id, project: onDisk.project, content: onDisk.content })
    } catch (e) {
      // Moved, deleted or damaged: keep working on the recovery copy; Save asks for a new file.
      setError(`Could not read "${file.handle.name}" (${e instanceof Error ? e.message : String(e)}). Showing the recovery copy.`)
      unlinkFile(id)
    }
  }

  const loadFileVersion = (id: string, fromFile: Project, handle: FileSystemFileHandle) => {
    rememberEdit()
    projectRef.current = fromFile
    setProject(fromFile)
    markSaved(id, fromFile, handle)
    setFileConflict(null)
  }

  const keepRecoveryCopy = (id: string, fileContent: string) => {
    acceptFileContent(id, fileContent)
    setFileConflict(null)
  }

  // Only on showing a tab; later checks come from the banner's button.
  useEffect(() => {
    checkFile(activeId, false)
  }, [activeId])

  const tabLabel = (tab: ProjectTab) => {
    const handle = projectFile(tab.id).handle
    return handle ? fileLabel(handle) : tab.name
  }

  const closeTab = async (id: string) => {
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return
    if (projectFile(id).dirty) {
      const choice = await askToSave(tabLabel(tab))
      if (choice === 'cancel' || (choice === 'save' && !(await saveTab(id)))) return
    }
    closeSavedTab(id)
  }

  const [saveQuestion, setSaveQuestion] = useState<{ name: string; answer: (choice: SaveChoice) => void } | null>(null)
  const askToSave = (name: string) =>
    new Promise<SaveChoice>((resolve) =>
      setSaveQuestion({
        name,
        answer: (choice) => {
          setSaveQuestion(null)
          resolve(choice)
        },
      }),
    )

  const closeSavedTab = (id: string) => {
    // Read fresh: an await in closeTab may have changed the tabs.
    const tabs = tabsRef.current
    const remaining = tabs.filter((t) => t.id !== id)
    if (remaining.length === 0) {
      // Always keep one tab: closing the last one leaves a fresh, empty project.
      const created = emptyProject(project.settings)
      addProject(id, created)
      const fresh = [{ id, name: created.name }]
      setTabs(fresh)
      writeTabs(fresh)
      history.current = NO_HISTORY
      projectRef.current = created
      setProject(created)
      setSelection(null)
      return
    }
    setTabs(remaining)
    writeTabs(remaining)
    if (id === activeIdRef.current) {
      const neighbour = remaining[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]
      showTab(neighbour.id, readProject(neighbour.id))
    }
    parkedHistory.current.delete(id)
    removeProject(id)
  }

  const setLayers = (next: Layers) => {
    setLayersState(next)
    writePreference(LAYERS_KEY, JSON.stringify(next))
  }

  const setSchematicLayers = (next: SchematicLayers) => {
    setSchematicLayersState(next)
    writePreference(SCHEMATIC_LAYERS_KEY, JSON.stringify(next))
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
      history.current = NO_HISTORY
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

  // Schematic edits leave the PCB alone; "Update PCB" takes their nets over when the user is ready.
  const changeSchematic = (next: FullSchematic) => setProject((p) => ({ ...p, schematic: next }))

  const updatePcb = () => {
    rememberEdit()
    setProject(withSchematicNets)
  }

  const rotateSelected = (degrees: number, pane: Pane) => {
    if (refsToEdit.length === 0) return
    rememberEdit()
    if (pane === 'schematic') {
      // Symbols only turn in quarter turns, so their pins stay on the grid.
      const quarterTurns = Math.max(1, Math.round(degrees / 90)) * 90
      const rotated = fullSchematic.placements
        .filter((p) => refsToEdit.includes(p.ref))
        .map((p) => ({ ...p, rotation: (p.rotation + quarterTurns) % 360 }))
      changeSchematic(withPlacementChanges(fullSchematic, builtNetlist, rotated))
      return
    }
    setLayout((l) => ({
      ...l,
      placements: l.placements.map((p) => (refsToEdit.includes(p.ref) ? { ...p, rotation: (p.rotation + degrees) % 360 } : p)),
    }))
  }

  /** Mirrors each selected symbol in place; wires and labels on its pins go along. */
  const flipSelected = (axis: 'horizontal' | 'vertical') => {
    if (refsToEdit.length === 0) return
    rememberEdit()
    const flippedParts = fullSchematic.placements.filter((p) => refsToEdit.includes(p.ref)).map((p) => flipped(p, axis))
    changeSchematic(withPlacementChanges(fullSchematic, builtNetlist, flippedParts))
  }

  const resetLeads = () => {
    if (refsToEdit.length === 0) return
    rememberEdit()
    setLayout((l) => ({
      ...l,
      placements: l.placements.map((p) => (refsToEdit.includes(p.ref) ? { ...p, leads: undefined } : p)),
    }))
  }

  const changePlacement = (ref: string, changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) => {
    rememberEdit()
    setLayout((l) => ({ ...l, placements: l.placements.map((p) => (p.ref === ref ? { ...p, ...changes } : p)) }))
  }

  /** Fills in or corrects a value, e.g. a transistor type the netlist left out. */
  const changeValue = (ref: string, value: string) => {
    rememberEdit()
    setProject((p) => ({ ...p, netlist: withValues(p.netlist, [{ ref, value }]) }))
  }

  const selectAll = () =>
    setSelection(selectionOf(layout.placements.map((p) => p.ref), layout.islands.map((i) => i.net)))

  const selectedIsland = selection?.kind === 'island' ? layout.islands.find((i) => i.net === selection.net) : undefined
  const canRemoveRect = selectedIsland !== undefined && selectedIsland.rects.length > 1

  const removeRect = () => {
    if (selection?.kind !== 'island' || !canRemoveRect) return
    rememberEdit()
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
    rememberEdit()
    setProject((p) => {
      const grid = createLayout(buildNetlist(p.netlist, p.layout.placements, p.definitions))
      return { ...p, layout: keepFootprintChoices(grid, p.layout) }
    })
    setSelection(null)
    setFitRequest((n) => n + 1)
  }

  const openFootprintDialog = () => setFootprintDialogRefs(selectedRefs(selection))

  const applyFootprint = (refs: ReadonlySet<string>, footprint: string | undefined) => {
    rememberEdit()
    setLayout((l) => changeFootprints(netlist, l, refs, footprint))
  }

  const editMode: EditMode = settings.strategy === 'knife' ? 'polygons' : 'rects'

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
    rememberEdit()
    setProject((p) => ({ ...p, layout: keepFootprintChoices(optimized, p.layout) }))
    setSelection(null)
    setFitRequest((n) => n + 1)
  }

  const exportLayout = () =>
    downloadText(`${project.name}-isolation.svg`, exportSvg(layout.islands, settings.isolation), 'image/svg+xml')

  const exportLayoutDxf = () => downloadText(`${project.name}-isolation.dxf`, exportDxf(layout.islands, settings.isolation), 'application/dxf')

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
    // An open dialog handles its own keys (Escape closes it); the canvas shortcuts stay out of the way.
    if (e.target instanceof Element && e.target.closest('dialog')) return
    const command = e.ctrlKey || e.metaKey
    // File shortcuts also work while typing in a field, instead of the browser's own.
    const key = e.key.toLowerCase()
    if (command && (key === 's' || key === 'o' || key === 'n')) {
      e.preventDefault()
      if (key === 's') saveTab(activeId, e.shiftKey)
      else if (key === 'o') openProjectFile()
      else newProject()
      return
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
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
    else if (e.key === ' ') {
      // Also stops a focused button from being clicked by the same key press.
      e.preventDefault()
      if (!e.repeat) rotateSelected(e.shiftKey ? 15 : 90, activePane)
    } else if (e.key === 'Delete' || e.key === 'Backspace') removeRect()
    else if (e.key === 'Escape') setSelection(null)
    else if (e.key === 'f' || e.key === 'F') setFitRequest((n) => n + 1)
    else if (e.key === 'v' || e.key === 'V') {
      setTool('select')
      setSchematicTool('select')
    } else if (e.key === 'w' || e.key === 'W') setSchematicTool('wire')
    else if (e.key === 'l' || e.key === 'L') setSchematicTool('label')
    else if (e.key === 'h' || e.key === 'H') setTool('pan')
    else if ((e.key === 'x' || e.key === 'X') && activePane === 'schematic') flipSelected('horizontal')
    else if ((e.key === 'y' || e.key === 'Y') && activePane === 'schematic') flipSelected('vertical')
    else if (e.key === 'm' || e.key === 'M') setMoveMode((mode) => (mode === 'part' ? 'body' : 'part'))
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => shortcuts.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app">
      {/* Same columns as the workspace below, so the project tabs start where the canvas does. */}
      <header className={`header view-${view}`}>
        <div className="header-start">
          <div className="menu" ref={fileMenuRef}>
            <button
              className="header-button"
              aria-haspopup="menu"
              aria-expanded={fileMenuOpen}
              onClick={() => setFileMenuOpen(!fileMenuOpen)}
            >
              <Icon name="file" />File<Icon name="chevronDown" />
            </button>
            {fileMenuOpen && (
              <div className="menu-list" role="menu" onClick={() => setFileMenuOpen(false)}>
                <button onClick={newProject} title="An empty project in a new tab">
                  <Icon name="plus" />New project<kbd>Ctrl+N</kbd>
                </button>
                <button onClick={openProjectFile} title="Open a project file in a new tab">
                  <Icon name="open" />Open…<kbd>Ctrl+O</kbd>
                </button>
                {/* Opens on hover, or on a click (keyboard, touch), which must not close the File menu. */}
                <div className="submenu">
                  <button aria-haspopup="menu" onClick={(e) => e.stopPropagation()}>
                    <Icon name="sample" />Examples<Icon name="chevronRight" />
                  </button>
                  <div className="menu-list submenu-list" role="menu">
                    {EXAMPLES.map((example) => (
                      <button key={example.name} onClick={() => openInNewTab(example.open())} title="A copy of this example in a new tab">
                        {example.name}
                      </button>
                    ))}
                  </div>
                </div>
                <button onClick={() => saveTab(activeId)} title="Save this tab's project to its file">
                  <Icon name="save" />Save<kbd>Ctrl+S</kbd>
                </button>
                <button onClick={() => saveTab(activeId, true)} title="Save this tab's project to another file">
                  <Icon name="save" />Save as…<kbd>Ctrl+Shift+S</kbd>
                </button>
                <hr />
                <button onClick={() => fileInputRef.current!.click()}><Icon name="file" />Import netlist…</button>
                <button onClick={exportLayout} title="Cut paths with stroke width = isolation"><Icon name="export" />Export SVG</button>
                <button onClick={exportLayoutDxf} title="Area to burn as closed contours in mm (board outline + copper as holes), ready to hatch in EzCad">
                  <Icon name="export" />Export DXF
                </button>
              </div>
            )}
          </div>
          {/* Outside the menu, so they stay mounted while the file dialog is open. */}
          <input
            ref={projectFileInputRef}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => onProjectFileChosen(e.target.files?.[0])}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".tel,.enet,.json,.net,.txt"
            hidden
            onChange={(e) => onFileChosen(e.target.files?.[0])}
          />
          <button
            className="header-button ai-button"
            onClick={() => setShowAiHelp(true)}
            title={agentConnected ? 'AI agent connected (MCP)' : 'Let an AI assistant edit this layout (MCP)'}
          >
            <Icon name="ai" />AI
            <span className={agentConnected ? 'agent-dot connected' : 'agent-dot'} aria-label={agentConnected ? 'Agent connected' : 'No agent'} />
          </button>
          <button
            className="icon-button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle dark mode"
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <button className="icon-button" onClick={() => setShowHelp(true)} title="Keyboard and mouse shortcuts" aria-label="Help">
            <Icon name="help" />
          </button>
        </div>
        <ProjectTabs
          tabs={tabs.map((tab) => ({ id: tab.id, label: tabLabel(tab), unsaved: projectFile(tab.id).dirty }))}
          activeId={activeId}
          onSwitch={switchTab}
          onClose={closeTab}
        />
        <div className="view-switch" role="group" aria-label="View">
          <button className={view === 'schematic' ? 'active' : ''} aria-pressed={view === 'schematic'} onClick={() => showView('schematic')}>
            <Icon name="schematic" />Schematic
          </button>
          <button
            className={view === 'split' ? 'active' : ''}
            aria-pressed={view === 'split'}
            onClick={() => showView('split')}
            title="Schematic and PCB side by side"
          >
            <Icon name="split" />Split
          </button>
          <button className={view === 'layout' ? 'active' : ''} aria-pressed={view === 'layout'} onClick={() => showView('layout')}>
            <Icon name="grid" />PCB
          </button>
        </div>
      </header>

      <div className={`workspace view-${view}`}>
        {view !== 'layout' && (
          <aside className="sidebar">
            {/* The schematic panel has the most room, so the shared list lives here and takes the rest of its height. */}
            <Section title={`Components (${schematicNetlist.components.length})`} fill>
              <ComponentList netlist={schematicNetlist} selection={selection} onSelect={setSelection} />
            </Section>
            <Section title="Properties">
              <PartProperties netlist={schematicNetlist} selection={selection} onValueChange={changeValue} />
            </Section>
            <Section title="Electrical check">
              <SchematicCheck
                shorts={schematicNets.conflicts.map((c) => c.names)}
                openPins={schematicOpenPins}
                pinsNotInPcb={pinsNotInPcb}
                onUpdatePcb={updatePcb}
              />
            </Section>
          </aside>
        )}

        <main className="canvas-area">
          {/* Floating over the canvas: a banner that pushed the canvas down would move it under a drag. */}
          <div className="canvas-banners">
            {error && (
              <div className="error-banner" role="alert">
                {error}
                <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss">✕</button>
              </div>
            )}
            {fileConflict?.id === activeId ? (
              <div className="sync-banner" role="alert">
                <span>"{tabLabel({ id: activeId, name: project.name })}" changed on disk, and this tab has changes that were not saved.</span>
                <button className="header-button" onClick={() => loadFileVersion(activeId, fileConflict.project, projectFile(activeId).handle!)} title="Show the file; the recovered changes stay reachable with Undo">
                  Use file
                </button>
                <button className="header-button" onClick={() => keepRecoveryCopy(activeId, fileConflict.content)} title="Keep editing the recovered changes; Save overwrites the file">
                  Keep recovered changes
                </button>
              </div>
            ) : (
              projectFile(activeId).handle &&
              !projectFile(activeId).checked && (
                <div className="sync-banner" role="status">
                  <span>Showing the recovery copy of "{tabLabel({ id: activeId, name: project.name })}"; the file itself was not checked yet.</span>
                  <button className="header-button" onClick={() => checkFile(activeId, true)} title="Allow access to the file and compare it with the recovery copy">
                    <Icon name="open" />Check file
                  </button>
                </div>
              )
            )}
            {pinsNotInPcb.length > 0 && (
              <div className="sync-banner" role="status">
                <span title={pinsNotInPcb.join(' ')}>
                  The schematic has changes the PCB does not have yet: {pinsNotInPcb.length} pin{pinsNotInPcb.length === 1 ? '' : 's'} on another net.
                </span>
                <button className="header-button" onClick={updatePcb} title="Give the PCB the schematic's nets; islands follow renamed and merged nets (can be undone)">
                  <Icon name="convert" />Update PCB
                </button>
              </div>
            )}
          </div>
          <div className="canvas-panes">
            {view !== 'layout' && (
              <section className="canvas-pane" onPointerDownCapture={() => setActivePane('schematic')}>
                <nav className="tool-rail" aria-label="Schematic tools">
                  <div className="rail-group" role="group" aria-label="Tools">
                    {SCHEMATIC_TOOLS.map(({ id, icon, label, title }) => (
                      <button
                        key={id}
                        className={schematicTool === id ? 'rail-button active' : 'rail-button'}
                        onClick={() => setSchematicTool(id)}
                        aria-pressed={schematicTool === id}
                        title={title}
                      >
                        <Icon name={icon} />{label}
                      </button>
                    ))}
                    <button className="rail-button" onClick={() => setFitRequest((n) => n + 1)} title="Fit the schematic in view (F)">
                      <Icon name="fit" />Fit
                    </button>
                  </div>
                  <div className="rail-group" role="group" aria-label="Component">
                    <button className="rail-button" onClick={() => rotateSelected(90, 'schematic')} disabled={refsToEdit.length === 0} title="Rotate a quarter turn (Space)">
                      <Icon name="rotate" />Rotate
                    </button>
                    <button className="rail-button" onClick={() => flipSelected('horizontal')} disabled={refsToEdit.length === 0} title="Mirror left to right (X)">
                      <Icon name="flipHorizontal" />Flip H
                    </button>
                    <button className="rail-button" onClick={() => flipSelected('vertical')} disabled={refsToEdit.length === 0} title="Mirror top to bottom (Y)">
                      <Icon name="flipVertical" />Flip V
                    </button>
                  </div>
                  <div className="rail-group view">
                    <ViewMenu>
                      <SchematicLayerToggles layers={schematicLayers} onChange={setSchematicLayers} />
                    </ViewMenu>
                  </div>
                </nav>
                <div className="canvas-frame">
                  <SchematicView
                    netlist={schematicNetlist}
                    schematic={fullSchematic}
                    nets={schematicNets}
                    onChange={changeSchematic}
                    onBeginEdit={rememberEdit}
                    selection={selection}
                    onSelect={setSelection}
                    tool={schematicTool}
                    fitRequest={fitRequest}
                    layers={schematicLayers}
                  />
                </div>
              </section>
            )}
            {view !== 'schematic' && (
              <section className="canvas-pane" onPointerDownCapture={() => setActivePane('layout')}>
                <nav className="tool-rail" aria-label="Tools">
                  <div className="rail-group" role="group" aria-label="View">
                    <button
                      className={tool === 'select' ? 'rail-button active' : 'rail-button'}
                      onClick={() => setTool('select')}
                      aria-pressed={tool === 'select'}
                      title="Select (V): drag empty space to select, Shift+drag adds"
                    >
                      <Icon name="select" />Select
                    </button>
                    <button
                      className={tool === 'pan' ? 'rail-button active' : 'rail-button'}
                      onClick={() => setTool('pan')}
                      aria-pressed={tool === 'pan'}
                      title="Pan (H): drag empty space to move the view; middle mouse always pans"
                    >
                      <Icon name="pan" />Pan
                    </button>
                    <button className="rail-button" onClick={() => setFitRequest((n) => n + 1)} title="Fit the board in view (F)">
                      <Icon name="fit" />Fit
                    </button>
                  </div>
                  <div className="rail-group" role="group" aria-label="Component">
                    <button
                      className={moveMode === 'body' ? 'rail-button active' : 'rail-button'}
                      onClick={() => setMoveMode(moveMode === 'body' ? 'part' : 'body')}
                      aria-pressed={moveMode === 'body'}
                      title={
                        'Anchor leads (M). On: dragging a part moves only its body, lead ends stay where they are soldered. ' +
                        'Off: the leads move along. Shift+drag always takes the leads along.'
                      }
                    >
                      <Icon name="moveBody" />Anchor
                    </button>
                    <button className="rail-button" onClick={() => rotateSelected(90, 'layout')} disabled={refsToEdit.length === 0} title="Rotate: Space = 90°, Shift+Space = 15°">
                      <Icon name="rotate" />Rotate
                    </button>
                    <button className="rail-button" onClick={resetLeads} disabled={refsToEdit.length === 0} title="Straighten the selected parts' leads">
                      <Icon name="leads" />Leads
                    </button>
                    <button className="rail-button" onClick={openFootprintDialog} disabled={refsToEdit.length === 0} title="Choose another footprint for the selected parts">
                      <Icon name="convert" />Footprint
                    </button>
                  </div>
                  <div className="rail-group view">
                    <ViewMenu>
                      <LayerToggles layers={layers} onChange={setLayers} />
                    </ViewMenu>
                  </div>
                </nav>
                <div className="canvas-frame">
                  <Canvas
                    netlist={builtNetlist}
                    layout={layout}
                    onLayoutChange={setLayout}
                    onBeginEdit={rememberEdit}
                    selection={selection}
                    onSelect={setSelection}
                    snap={settings.snap}
                    isolation={settings.isolation}
                    problemNets={problemNets}
                    fitRequest={fitRequest}
                    layers={layers}
                    tool={tool}
                    moveMode={moveMode}
                    editMode={editMode}
                  />
                </div>
              </section>
            )}
          </div>
        </main>

        {view !== 'schematic' && (
          <aside className="sidebar">
            <Section title="Placement">
              <SelectionDetails
                netlist={builtNetlist}
                layout={layout}
                selection={selection}
                onPlacementChange={changePlacement}
                onChangeFootprint={openFootprintDialog}
              />
            </Section>
            <Section title="Optimizer">
              <div className="settings">
                <label title={findStrategy(settings.strategy).description}>
                  Mode
                  <select value={settings.strategy} onChange={(e) => setSettings({ strategy: e.target.value })}>
                    {STRATEGIES.map((s) => (
                      <option key={s.id} value={s.id} title={s.description}>{s.label}</option>
                    ))}
                  </select>
                </label>
                <button className="optimize-button" onClick={optimize} title={findStrategy(settings.strategy).description}>
                  <Icon name="optimize" />Optimize
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
                <button className="reset-grid" onClick={resetToGrid}><Icon name="grid" />Reset to grid</button>
                {boardSize && (
                  <p className="board-size">Board {boardSize.w.toFixed(1)} × {boardSize.h.toFixed(1)} mm</p>
                )}
              </div>
            </Section>
            <Section title="Design rule check">
              <Validation
                components={netlist.components.length}
                nets={netlist.nets.length}
                openPins={pinCounts.open}
                shortedPins={pinCounts.short}
                netsTooClose={spacingViolations.size}
                netsSplit={splitNets.size}
              />
            </Section>
            {/* The component list lives in the schematic panel; only without it does the PCB panel show one. */}
            {view === 'layout' && (
              <Section title={`Components (${builtNetlist.components.length})`} fill>
                <ComponentList
                  netlist={builtNetlist}
                  selection={selection}
                  onSelect={setSelection}
                  pcb={{ refsWithIssues: pinCounts.refsWithIssues, onChangeFootprint: openFootprintDialog }}
                />
              </Section>
            )}
          </aside>
        )}
      </div>

      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {showAiHelp && <AiHelpDialog agentConnected={agentConnected} onClose={() => setShowAiHelp(false)} />}
      {saveQuestion && <SaveChangesDialog name={saveQuestion.name} onAnswer={saveQuestion.answer} />}
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
