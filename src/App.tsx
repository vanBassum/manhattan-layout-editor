import { useEffect, useMemo, useRef, useState } from 'react'
import { connectAgentBridge } from './agentBridge'
import { buildNetlist, buildProjectNetlist, withDefinitions } from './definitions'
import { agentTargetId, runAgentCommand } from './agentDispatch'
import { Canvas, type EditMode, type Layers, type LayerView, type MoveMode, type Tool } from './Canvas'
import { exportDxf } from './exportDxf'
import { errorText } from './errorText'
import { downloadText, exportSvg } from './exportSvg'
import { FootprintDialog } from './FootprintDialog'
import { boundsOf } from './geometry'
import {
  analyzeLeads,
  changeFootprints,
  createLayout,
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
  QuestionDialog,
  PCB_LAYERS,
  SchematicCheck,
  SCHEMATIC_LAYERS,
  Section,
  SelectionDetails,
  Validation,
  ViewMenu,
  type Question,
} from './panels'
import { canUseFiles, compareWithFile, fileLabel, mayUse, pickFileToOpen, readFile, saveProjectFile } from './projectFiles'
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
  restoreErrors,
  unlinkFile,
  writeProject,
  writeTabs,
  type ProjectTab,
} from './projectStore'
import { canvasToPng } from './screenshot'
import { shareLinkOf, takeSharedProject } from './shareLink'
import { selectedRefs, selectedWiring, selectionOf } from './selection'
import { screenshotHidden } from './hiddenScreenshot'
import {
  completeSchematic,
  deriveNets,
  flipped,
  pinsWithOtherNet,
  withPlacementChanges,
  withSchematicNets,
  type FullSchematic,
} from './schematic'
import { SchematicView, type SchematicLayers, type SchematicTool } from './SchematicView'
import type { Layout, NetLabel, Placement, Project, SchematicPlacement, Selection, Settings } from './types'
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
      'Select (V): click parts, wires, labels and wire corners; Shift+click adds. Drag empty space to the right to ' +
      'select what lies inside, to the left for what it touches. Dragging the selection keeps its connections; ' +
      'Shift+drag moves it alone. Drag from a pin end to draw a wire (Shift: from a wire end). Del removes wires and labels',
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
  return 'split'
}

type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const stored = readPreference(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
const SHOWN: LayerView = { visible: true, opacity: 1 }
const ALL_LAYERS: Layers = { islands: SHOWN, parts: SHOWN, references: SHOWN, values: SHOWN, netLabels: SHOWN, leads: SHOWN, grid: SHOWN }

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

/** The layer settings stored under `key`, with `defaults` for layers it does not mention. */
function loadLayerViews<Name extends string>(key: string, defaults: Record<Name, LayerView>): Record<Name, LayerView> {
  const stored = readPreference(key)
  if (!stored) return defaults
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const layers = { ...defaults }
    for (const layer of Object.keys(layers) as Name[]) {
      if (layer in parsed) layers[layer] = parseLayerView(parsed[layer])
    }
    return layers
  } catch {
    return defaults
  }
}

/** Net names are off until asked for: the wires already show what connects, the names only add clutter. */
const DEFAULT_SCHEMATIC_LAYERS: SchematicLayers = {
  grid: SHOWN,
  references: SHOWN,
  values: SHOWN,
  pinNumbers: SHOWN,
  netNames: { visible: false, opacity: 1 },
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
  const previousLayout = keepLayout ? current.layout : undefined
  const definitions = keepLayout ? current.definitions : undefined
  return withDefinitions({
    guid: current.guid,
    name,
    netlist,
    layout: createLayout(buildNetlist(netlist, previousLayout?.placements ?? [], definitions), previousLayout),
    // Symbols stay where they were; wires and labels start over from the imported nets.
    schematic: keepLayout && current.schematic ? { placements: current.schematic.placements } : undefined,
    definitions,
    settings: keepLayout ? current.settings : DEFAULT_SETTINGS,
  })
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
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])
  const showView = (mode: ViewMode) => {
    setView(mode)
    if (mode !== 'split') setActivePane(mode)
    writePreference(VIEW_KEY, mode)
  }
  const [fitRequest, setFitRequest] = useState(1)
  const refit = () => setFitRequest((n) => n + 1)
  const [error, setError] = useState(() => restoreErrors.join(' '))
  /** A short confirmation, e.g. that a link was copied; it goes away by itself. */
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])
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
  const [layers, setLayersState] = useState(() => loadLayerViews(LAYERS_KEY, ALL_LAYERS))
  const [schematicLayers, setSchematicLayersState] = useState(() => loadLayerViews(SCHEMATIC_LAYERS_KEY, DEFAULT_SCHEMATIC_LAYERS))
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

  // Latest project and shown tab, also between a change and the next render: agent commands and file
  // checks can arrive in between. Only showProject and showTab change them, always together with the
  // state, so they are never behind it. (tabsRef may lag one render; a lookup then only misses a tab.)
  const projectRef = useRef(project)
  const activeIdRef = useRef(activeId)

  /** Every change to the shown project goes through here. */
  const showProject = (next: Project) => {
    projectRef.current = next
    setProject(next)
  }
  const updateProject = (update: (current: Project) => Project) => showProject(update(projectRef.current))

  const restore = (snapshot: Snapshot) => updateProject((current) => ({ ...current, ...snapshot }))

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
      // A selection names schematic wires and labels by index; new ones mean other things.
      if (changes.schematic) setSelection(null)
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
    const id = agentTargetId(tabsRef.current, activeIdRef.current, args.project)
    const shown = id === activeIdRef.current
    const stored = shown ? projectRef.current : readProject(id)
    const result = runAgentCommand(command, args, {
      project: stored,
      change: (changes) => applyAgentChange(id, stored, changes),
      step: (direction) => {
        if (!shown) return stepHiddenTab(id, stored, direction)
        stepShownTab(direction)
        return projectRef.current
      },
      screenshot: (current, bounds) => {
        // The layout is not on screen for another tab, or while only the schematic is shown.
        const svg = shown ? document.querySelector<SVGSVGElement>('svg.canvas') : null
        return svg ? canvasToPng(svg, bounds) : screenshotHidden(current.netlist, current.layout, current.settings.isolation, bounds)
      },
    })
    if (shown && command === 'run_optimizer') refit()
    return result
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
          showProject(change.project)
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
    const activeId = activeIdRef.current
    writeProject(activeId, projectRef.current)
    parkedHistory.current.set(activeId, history.current)
    history.current = parkedHistory.current.get(id) ?? NO_HISTORY
    parkedHistory.current.delete(id)
    showProject(next)
    activeIdRef.current = id
    setActiveId(id)
    rememberActiveTab(id)
    setSelection(null)
    setError('')
    refit()
  }

  const switchTab = (id: string) => {
    if (id !== activeId) showTab(id, readProject(id))
  }

  const openInNewTab = (opened: Project, handle?: FileSystemFileHandle) => {
    const id = newTabId()
    addProject(id, opened, handle)
    const next = [...tabsRef.current, { id, name: opened.name }]
    setTabs(next)
    writeTabs(next)
    showTab(id, opened)
  }

  const newProject = () => openInNewTab(emptyProject(project.settings))

  // A share link opens its project in a new tab once the editor is up.
  useEffect(() => {
    takeSharedProject()
      .then((shared) => shared && openInNewTab(shared))
      .catch((e) => setError(`Could not open the shared project: ${errorText(e)}`))
  }, [])

  const copyShareLink = async () => {
    let link: string
    try {
      link = await shareLinkOf(projectRef.current)
    } catch (e) {
      setError(`Could not make a share link: ${errorText(e)}`)
      return
    }
    try {
      await navigator.clipboard.writeText(link)
      setNotice('Share link copied. Whoever opens it gets their own copy of this project.')
    } catch {
      prompt('Copy the share link:', link)
    }
  }

  /** The project of tab `id`, including changes still waiting to be written to the recovery copy. */
  const shownProject = (id: string) => (id === activeIdRef.current ? projectRef.current : readProject(id))

  const [question, setQuestion] = useState<{ question: Question<string>; answer: (answer: string) => void } | null>(null)
  /** Shows `question` in a dialog and resolves to the answer picked. */
  const ask = <Answer extends string>(question: Question<Answer>) =>
    new Promise<Answer>((resolve) =>
      setQuestion({
        question,
        answer: (answer) => {
          setQuestion(null)
          resolve(answer as Answer)
        },
      }),
    )

  const confirmOverwrite = async (fileName: string) => {
    const answer = await ask({
      title: `Overwrite "${fileName}"?`,
      text: 'The file changed on disk since it was opened or saved here.',
      choices: [{ answer: 'cancel', label: 'Cancel' }, { answer: 'overwrite', label: 'Overwrite' }],
      cancel: 'cancel',
    })
    return answer === 'overwrite'
  }

  /** Saves tab `id` to its file, or asks for one; false when nothing was saved. */
  const saveTab = async (id: string, saveAs = false): Promise<boolean> => {
    const toSave = shownProject(id)
    try {
      if (!canUseFiles) {
        downloadText(`${toSave.name}.manhattan.json`, projectToFile(toSave), 'application/json')
        markSaved(id, toSave)
        return true
      }
      const handle = await saveProjectFile(toSave, projectFile(id), saveAs, confirmOverwrite)
      if (!handle) return false
      markSaved(id, toSave, handle)
      return true
    } catch (e) {
      setError(`Could not save: ${errorText(e)}`)
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
      setError(errorText(e))
    }
  }

  /**
   * After a reload the tab shows its recovery copy. Compares the file with it: an unchanged file
   * needs nothing, a file changed elsewhere replaces a copy without unsaved changes, and with
   * changes on both sides the user picks. Without permission yet (`askPermission` false) it waits for a click.
   */
  const [fileConflict, setFileConflict] = useState<{ id: string; project: Project; content: string } | null>(null)
  const checkFile = async (id: string, askPermission: boolean) => {
    const file = projectFile(id)
    if (!file.handle || file.checked) return
    try {
      if (!(await mayUse(file.handle, askPermission))) return
      const comparison = await compareWithFile(file.handle, file)
      if (id !== activeIdRef.current) return
      if (comparison.kind === 'unchanged') acceptFileContent(id, comparison.content)
      else if (comparison.kind === 'newer') loadFileVersion(id, comparison.project, file.handle)
      else setFileConflict({ id, project: comparison.project, content: comparison.content })
    } catch (e) {
      // Moved, deleted or damaged: keep working on the recovery copy; Save asks for a new file.
      setError(`Could not read "${file.handle.name}" (${errorText(e)}). Showing the recovery copy.`)
      unlinkFile(id)
    }
  }

  const loadFileVersion = (id: string, fromFile: Project, handle: FileSystemFileHandle) => {
    rememberEdit()
    showProject(fromFile)
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
      const choice = await ask({
        title: `Save changes to "${tabLabel(tab)}"?`,
        text: 'Closing without saving throws the changes away.',
        choices: [{ answer: 'discard', label: "Don't save" }, { answer: 'cancel', label: 'Cancel' }, { answer: 'save', label: 'Save' }],
        cancel: 'cancel',
      })
      if (choice === 'cancel' || (choice === 'save' && !(await saveTab(id)))) return
    }
    closeSavedTab(id)
  }


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
      showProject(created)
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
    updateProject((p) => ({ ...p, layout: update(p.layout) }))

  const setSettings = (changes: Partial<Settings>) =>
    updateProject((p) => ({ ...p, settings: { ...p.settings, ...changes } }))

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
      updateProject((p) => projectFromNetlist(name, text, p, keepLayout))
      // Old layouts belong to the old netlist.
      history.current = NO_HISTORY
      setSelection(null)
      setError('')
      refit()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return
    fileInputRef.current!.value = ''
    const answer = await ask({
      title: 'Import netlist',
      text: 'Keep the current positions of matching nets and components, or start over on a fresh grid?',
      choices: [{ answer: 'cancel', label: 'Cancel' }, { answer: 'fresh', label: 'Fresh grid' }, { answer: 'keep', label: 'Keep positions' }],
      cancel: 'cancel',
    })
    if (answer === 'cancel') return
    loadNetlist(file.name.replace(/\.[^.]+$/, ''), await file.text(), answer === 'keep')
  }

  /** Changes the placements of `refs` with `change`, as one undo step; nothing when `refs` is empty. */
  const editPlacements = (refs: string[], change: (p: Placement) => Placement) => {
    if (refs.length === 0) return
    rememberEdit()
    setLayout((l) => ({ ...l, placements: l.placements.map((p) => (refs.includes(p.ref) ? change(p) : p)) }))
  }

  // Rotate and reset leads act on every selected part, each in place.
  const refsToEdit = selectedRefs(selection)

  // Schematic edits leave the PCB alone; "Update PCB" takes their nets over when the user is ready.
  const changeSchematic = (next: FullSchematic) => updateProject((p) => ({ ...p, schematic: next }))

  const updatePcb = () => {
    rememberEdit()
    updateProject(withSchematicNets)
  }

  // Ground and power symbols turn and flip like parts do.
  const labelsToTurn = selectedWiring(selection).labels
  const canTurnSchematic = refsToEdit.length > 0 || labelsToTurn.length > 0

  /** The schematic with the selected parts changed by `turnPart` and the selected labels' rotation by `turnLabel`. */
  const turnedSchematic = (turnPart: (p: SchematicPlacement) => SchematicPlacement, turnLabel: (rotation: number) => number) => {
    const turnedParts = fullSchematic.placements.filter((p) => refsToEdit.includes(p.ref)).map(turnPart)
    const next = withPlacementChanges(fullSchematic, builtNetlist, turnedParts)
    const labels = next.labels.map((l, i) => (labelsToTurn.includes(i) ? { ...l, rotation: turnLabel(l.rotation ?? 0) } : l))
    return { ...next, labels }
  }

  const rotateSelected = (degrees: number, pane: Pane) => {
    if (pane === 'schematic') {
      if (!canTurnSchematic) return
      rememberEdit()
      // Symbols only turn in quarter turns, so their pins stay on the grid.
      const quarterTurns = Math.max(1, Math.round(degrees / 90)) * 90
      changeSchematic(
        turnedSchematic(
          (p) => ({ ...p, rotation: (p.rotation + quarterTurns) % 360 }),
          (rotation) => (rotation + quarterTurns) % 360,
        ),
      )
      return
    }
    editPlacements(refsToEdit, (p) => ({ ...p, rotation: (p.rotation + degrees) % 360 }))
  }

  /** Mirrors each selected symbol in place; wires and labels on its pins go along. */
  const flipSelected = (axis: 'horizontal' | 'vertical') => {
    if (!canTurnSchematic) return
    rememberEdit()
    // A ground or power symbol is symmetric, so mirroring it only changes which way it points.
    const turn = axis === 'horizontal' ? 360 : 540
    changeSchematic(turnedSchematic((p) => flipped(p, axis), (rotation) => (turn - rotation) % 360))
  }

  const changeLabel = (index: number, changes: Partial<NetLabel>) => {
    rememberEdit()
    changeSchematic({ ...fullSchematic, labels: fullSchematic.labels.map((l, i) => (i === index ? { ...l, ...changes } : l)) })
  }

  const resetLeads = () => editPlacements(refsToEdit, (p) => ({ ...p, leads: undefined }))

  const changePlacement = (ref: string, changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) =>
    editPlacements([ref], (p) => ({ ...p, ...changes }))

  /** Fills in or corrects a value, e.g. a transistor type the netlist left out. */
  const changeValue = (ref: string, value: string) => {
    rememberEdit()
    updateProject((p) => ({ ...p, netlist: withValues(p.netlist, [{ ref, value }]) }))
  }

  const selectAll = () => {
    const wiring = { wires: fullSchematic.wires.map((_, i) => i), labels: fullSchematic.labels.map((_, i) => i), points: [] }
    setSelection(selectionOf(layout.placements.map((p) => p.ref), layout.islands.map((i) => i.net), wiring))
  }

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

  const resetToGrid = async () => {
    const answer = await ask({
      title: 'Reset to grid',
      text: 'Discard all manual placement and put everything back on a grid? This can be undone.',
      choices: [{ answer: 'cancel', label: 'Cancel' }, { answer: 'reset', label: 'Reset' }],
      cancel: 'cancel',
    })
    if (answer === 'cancel') return
    rememberEdit()
    updateProject((p) => {
      const grid = createLayout(buildProjectNetlist(p))
      return { ...p, layout: keepFootprintChoices(grid, p.layout) }
    })
    setSelection(null)
    refit()
  }

  const openFootprintDialog = () => setFootprintDialogRefs(selectedRefs(selection))

  const applyFootprint = (refs: ReadonlySet<string>, footprint: string | undefined) => {
    rememberEdit()
    setLayout((l) => changeFootprints(netlist, l, refs, footprint))
  }

  const editMode: EditMode = settings.strategy === 'knife' ? 'polygons' : 'rects'

  const optimize = async () => {
    const strategy = findStrategy(settings.strategy)
    const answer = await ask({
      title: 'Optimize',
      text: `Replace the current layout with a new ${strategy.label} layout? This can be undone.`,
      choices: [{ answer: 'cancel', label: 'Cancel' }, { answer: 'replace', label: 'Replace layout' }],
      cancel: 'cancel',
    })
    if (answer === 'cancel') return
    let optimized: Layout
    try {
      optimized = strategy.run(builtNetlist, settings)
    } catch (e) {
      setError(errorText(e))
      return
    }
    rememberEdit()
    updateProject((p) => ({ ...p, layout: keepFootprintChoices(optimized, p.layout) }))
    setSelection(null)
    refit()
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
      setError(errorText(e))
    }
  }

  // Keyboard shortcuts; handlers are recreated each render so they always see current state.
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {})
  shortcuts.current = (e: KeyboardEvent) => {
    // An open dialog handles its own keys (Escape closes it); the canvas shortcuts stay out of the way.
    if (e.target instanceof Element && e.target.closest('dialog')) return
    const key = e.key.toLowerCase()
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
    if (e.ctrlKey || e.metaKey) commandShortcut(e, key, typing)
    else if (!typing) plainShortcut(e, key)
  }

  /** Ctrl/Cmd shortcuts. The file ones also work while typing in a field, instead of the browser's own. */
  const commandShortcut = (e: KeyboardEvent, key: string, typing: boolean) => {
    const action = commandAction(key, e.shiftKey, typing)
    if (!action) return
    e.preventDefault()
    action()
  }

  const commandAction = (key: string, shift: boolean, typing: boolean): (() => void) | undefined => {
    switch (key) {
      case 's':
        return () => saveTab(activeId, shift)
      case 'o':
        return openProjectFile
      case 'n':
        return newProject
    }
    if (typing) return undefined
    switch (key) {
      case 'z':
        return shift ? redo : undo
      case 'y':
        return redo
      case 'a':
        return selectAll
    }
  }

  const plainShortcut = (e: KeyboardEvent, key: string) => {
    switch (key) {
      case ' ':
        // Also stops a focused button from being clicked by the same key press.
        e.preventDefault()
        if (!e.repeat) rotateSelected(e.shiftKey ? 15 : 90, activePane)
        return
      case 'delete':
      case 'backspace':
        return removeRect()
      case 'escape':
        return setSelection(null)
      case 'f':
        return refit()
      case 'v':
        setTool('select')
        return setSchematicTool('select')
      case 'w':
        return setSchematicTool('wire')
      case 'l':
        return setSchematicTool('label')
      case 'h':
        return setTool('pan')
      case 'x':
        if (activePane === 'schematic') flipSelected('horizontal')
        return
      case 'y':
        if (activePane === 'schematic') flipSelected('vertical')
        return
      case 'm':
        return setMoveMode((mode) => (mode === 'part' ? 'body' : 'part'))
    }
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
          <div className="menu" ref={menuRef}>
            <button
              className="header-button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
              title={agentConnected ? 'Menu (AI agent connected)' : 'Menu'}
            >
              <Icon name="menu" />Menu
              {agentConnected && <span className="agent-dot connected" aria-label="Agent connected" />}
            </button>
            {menuOpen && (
              <div className="menu-list" role="menu" onClick={() => setMenuOpen(false)}>
                <span className="menu-heading">Project</span>
                <button onClick={newProject} title="An empty project in a new tab">
                  <Icon name="plus" />New project<kbd>Ctrl+N</kbd>
                </button>
                <button onClick={openProjectFile} title="Open a project file in a new tab">
                  <Icon name="open" />Open…<kbd>Ctrl+O</kbd>
                </button>
                {/* Opens on hover, or on a click (keyboard, touch), which must not close the menu. */}
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
                <button onClick={copyShareLink} title="Copy a link that holds this whole project; opening it gives a copy in a new tab">
                  <Icon name="link" />Copy share link
                </button>
                <hr />
                <span className="menu-heading">Import and export</span>
                <button onClick={() => fileInputRef.current!.click()}><Icon name="file" />Import netlist…</button>
                <button onClick={exportLayout} title="Cut paths with stroke width = isolation"><Icon name="export" />Export SVG</button>
                <button onClick={exportLayoutDxf} title="Area to burn as closed contours in mm (board outline + copper as holes), ready to hatch in EzCad">
                  <Icon name="export" />Export DXF
                </button>
                <hr />
                <span className="menu-heading">Editor</span>
                <button onClick={() => setShowAiHelp(true)} title="Let an AI assistant edit this layout (MCP)">
                  <Icon name="ai" />AI assistant…
                  <span className={agentConnected ? 'agent-dot connected' : 'agent-dot'} aria-label={agentConnected ? 'Agent connected' : 'No agent'} />
                </button>
                <button onClick={toggleTheme}>
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
                  {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </button>
                <button onClick={() => setShowHelp(true)}>
                  <Icon name="help" />Keyboard and mouse
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
              <PartProperties
                netlist={schematicNetlist}
                labels={fullSchematic.labels}
                selection={selection}
                onValueChange={changeValue}
                onLabelChange={changeLabel}
              />
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
            {notice && (
              <div className="notice-banner" role="status">
                {notice}
                <button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss">✕</button>
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
                    <button className="rail-button" onClick={refit} title="Fit the schematic in view (F)">
                      <Icon name="fit" />Fit
                    </button>
                  </div>
                  <div className="rail-group" role="group" aria-label="Component">
                    <button className="rail-button" onClick={() => rotateSelected(90, 'schematic')} disabled={!canTurnSchematic} title="Rotate a quarter turn (Space)">
                      <Icon name="rotate" />Rotate
                    </button>
                    <button className="rail-button" onClick={() => flipSelected('horizontal')} disabled={!canTurnSchematic} title="Mirror left to right (X)">
                      <Icon name="flipHorizontal" />Flip H
                    </button>
                    <button className="rail-button" onClick={() => flipSelected('vertical')} disabled={!canTurnSchematic} title="Mirror top to bottom (Y)">
                      <Icon name="flipVertical" />Flip V
                    </button>
                  </div>
                  <div className="rail-group view">
                    <ViewMenu>
                      <LayerToggles info={SCHEMATIC_LAYERS} layers={schematicLayers} onChange={setSchematicLayers} />
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
                    <button className="rail-button" onClick={refit} title="Fit the board in view (F)">
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
                      <LayerToggles info={PCB_LAYERS} layers={layers} onChange={setLayers} opacityNote=" (below 50% the layer ignores clicks)" />
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
      {question && <QuestionDialog question={question.question} onAnswer={question.answer} />}
      {footprintDialogRefs && (
        <FootprintDialog
          built={builtNetlist}
          imported={netlist}
          definitions={project.definitions}
          initialRefs={footprintDialogRefs}
          isolation={settings.isolation}
          onApply={applyFootprint}
          onClose={() => setFootprintDialogRefs(null)}
        />
      )}
    </div>
  )
}
