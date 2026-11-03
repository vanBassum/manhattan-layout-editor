import { useEffect, useMemo, useRef, useState } from 'react'
import { connectAgentBridge } from './agentBridge'
import { buildNetlist, buildProjectNetlist, importedProject, reimportedProject } from './definitions'
import { runAgentCommand, type AgentTab } from './agentDispatch'
import { Canvas, DEFAULT_PCB_GRID_LINES_PER_MAJOR, type Layers, type LayerView, type MoveMode, type Tool } from './Canvas'
import { exportDxf } from './exportDxf'
import { driveConfigured, signOut } from './documents/googleDrive'
import { FileDialog } from './FileDialogs'
import { errorText } from './errorText'
import { downloadText, exportSvg } from './exportSvg'
import { FootprintDialog } from './FootprintDialog'
import { boundsOf } from './geometry'
import { changeFootprints, createLayout, findPinIssues, findProblemNets, findSpacingViolations, findSplitNets, keepFootprintChoices } from './layout'
import { withValues } from './netlist'
import { findStrategy, STRATEGIES } from './optimize'
import {
  AiHelpDialog,
  ComponentList,
  GRID_LINES_PER_MAJOR_OPTIONS,
  GridSettings,
  HelpDialog,
  Icon,
  LayerToggles,
  MenuGroup,
  PartProperties,
  QuestionDialog,
  PCB_LAYERS,
  SchematicCheck,
  SCHEMATIC_LAYERS,
  Section,
  SelectionDetails,
  RailMenu,
  Validation,
  type Question,
} from './panels'
import { EXAMPLES } from './documents/examples'
import { DEFAULT_SETTINGS } from './documents/projectFormat'
import { projectFile, recentDocuments, restoreErrors } from './documents/projectStore'
import { canvasToPng } from './screenshot'
import { shareLinkOf, takeSharedProject } from './documents/shareLink'
import { selectedRefs, selectedWiring, selectionOf } from './selection'
import { screenshotHidden } from './hiddenScreenshot'
import {
  completeSchematic,
  deriveNets,
  flippedSelection,
  pinsWithOtherNet,
  rotatedSelection,
  unconnectedPins,
  withLabelChanged,
  withSchematicNets,
  type FullSchematic,
} from './schematic'
import { SchematicView, type SchematicLayers, type SchematicTool } from './SchematicView'
import type { Layout, NetLabel, Placement, Project, Selection, Settings } from './types'
import type { IconName } from './panels'
import { ProjectTabs } from './ProjectTabs'
import { useDocuments } from './ui/useDocuments'
import { useTabs, type UndoDirection } from './ui/useTabs'

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
/** The name of a project opened from a share link, until it is saved. */
const SHARED_PROJECT = 'Shared project'
// Layer visibility is a per-browser view preference, deliberately not part of the project.
const LAYERS_KEY = 'manhattan-layout-editor/layers'
const SCHEMATIC_LAYERS_KEY = 'manhattan-layout-editor/schematic-layers'
const PCB_GRID_KEY = 'manhattan-layout-editor/pcb-grid-lines-per-major'
const SCHEMATIC_GRID_KEY = 'manhattan-layout-editor/schematic-grid-lines-per-major'
const DEFAULT_SCHEMATIC_GRID_LINES_PER_MAJOR = 6
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

function loadGridLinesPerMajor(key: string, fallback: number): number {
  const stored = Number(readPreference(key))
  return GRID_LINES_PER_MAJOR_OPTIONS.includes(stored) ? stored : fallback
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

/** A project update that changes the layout with `update`. */
const layoutUpdate =
  (update: (layout: Layout) => Layout) =>
  (project: Project): Project => ({ ...project, layout: update(project.layout) })

/** A project update that replaces the schematic. It leaves the PCB alone: "Update PCB" takes its nets over when the user is ready. */
const schematicUpdate =
  (schematic: FullSchematic) =>
  (project: Project): Project => ({ ...project, schematic })

export function App() {
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
  // Another tab starts with nothing selected, no error, and its board in view.
  const tabSession = useTabs(() => {
    setSelection(null)
    setError('')
    refit()
  })
  const {
    tabs,
    activeId,
    project,
    tabsRef,
    activeIdRef,
    tabName,
    shownProject,
    renameTab,
    switchTab,
    openInNewTab,
    newProject,
    closeSavedTab,
    updateProject,
    beginEdit,
    commitEdit,
    clearHistory,
    stepHiddenTab,
    changeHiddenTab,
  } = tabSession
  const fileInputRef = useRef<HTMLInputElement>(null)
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
  const [pcbGrid, setPcbGridState] = useState(() => loadGridLinesPerMajor(PCB_GRID_KEY, DEFAULT_PCB_GRID_LINES_PER_MAJOR))
  const [schematicGrid, setSchematicGridState] = useState(() =>
    loadGridLinesPerMajor(SCHEMATIC_GRID_KEY, DEFAULT_SCHEMATIC_GRID_LINES_PER_MAJOR),
  )
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
  const schematicOpenPins = useMemo(() => unconnectedPins(schematicNets.netlist), [schematicNets])

  const stepShownTab = (direction: UndoDirection) => {
    if (tabSession.stepShownTab(direction)) setSelection(null)
  }
  const undo = () => stepShownTab('undo')
  const redo = () => stepShownTab('redo')

  /** Tab `id` as agent command `command` works on it. */
  const agentTab = (id: string, command: string): AgentTab => {
    const shown = id === activeIdRef.current
    const stored = shownProject(id)
    return {
      project: stored,
      change: (changes) => {
        if (!shown) return changeHiddenTab(id, stored, changes)
        commitEdit((current) => ({ ...current, ...changes }))
        // A selection names schematic wires and labels by index; new ones mean other things.
        if (changes.schematic) setSelection(null)
        // A whole new layout, as with the Optimize button.
        if (command === 'run_optimizer') refit()
        return shownProject(id)
      },
      step: (direction) => {
        if (!shown) return stepHiddenTab(id, stored, direction)
        stepShownTab(direction)
        return shownProject(id)
      },
      screenshot: (current, bounds) => {
        // The layout is not on screen for another tab, or while only the schematic is shown.
        const svg = shown ? document.querySelector<SVGSVGElement>('svg.canvas') : null
        return svg ? canvasToPng(svg, bounds) : screenshotHidden(current.netlist, current.layout, current.settings.isolation, bounds)
      },
    }
  }

  const handleAgentCommand = useRef<(command: string, args: Record<string, unknown>) => unknown>(() => undefined)
  handleAgentCommand.current = (command, args) =>
    runAgentCommand(command, args, { tabs: tabsRef.current, shownId: activeIdRef.current, tab: (id) => agentTab(id, command) })

  useEffect(
    () => connectAgentBridge((command, args) => handleAgentCommand.current(command, args), setAgentConnected),
    [],
  )

  // A share link opens its project in a new tab once the editor is up.
  useEffect(() => {
    takeSharedProject()
      .then((shared) => shared && openInNewTab(shared, SHARED_PROJECT))
      .catch((e) => setError(`Could not open the shared project: ${errorText(e)}`))
  }, [])

  const copyShareLink = async () => {
    let link: string
    try {
      link = await shareLinkOf(shownProject(activeIdRef.current))
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

  /** Asks a yes/no question; true when the user picks `confirmLabel` rather than Cancel. */
  const confirm = async (title: string, text: string, confirmLabel: string) => {
    const answer = await ask({ title, text, choices: [{ answer: 'cancel', label: 'Cancel' }, { answer: 'confirm', label: confirmLabel }], cancel: 'cancel' })
    return answer === 'confirm'
  }

  const {
    signedIn,
    signInToGoogle,
    saveTab,
    fileDialog,
    showOpenDialog,
    closeFileDialog,
    openRecent,
    openFromDrive,
    openProjectFile,
    uploadInputRef,
    openUploadedFile,
    fileConflict,
    checkSaved,
    loadSavedVersion,
    keepRecoveryCopy,
  } = useDocuments(tabSession, setError, confirm)

  const closeTab = async (id: string) => {
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return
    if (projectFile(id).dirty) {
      const choice = await ask({
        title: `Save changes to "${tab.name}"?`,
        text: 'Closing without saving throws the changes away.',
        choices: [{ answer: 'discard', label: "Don't save" }, { answer: 'cancel', label: 'Cancel' }, { answer: 'save', label: 'Save' }],
        cancel: 'cancel',
      })
      if (choice === 'cancel' || (choice === 'save' && !(await saveTab(id)))) return
    }
    closeSavedTab(id)
  }

  const setLayers = (next: Layers) => {
    setLayersState(next)
    writePreference(LAYERS_KEY, JSON.stringify(next))
  }

  const setSchematicLayers = (next: SchematicLayers) => {
    setSchematicLayersState(next)
    writePreference(SCHEMATIC_LAYERS_KEY, JSON.stringify(next))
  }

  const setPcbGrid = (linesPerMajor: number) => {
    setPcbGridState(linesPerMajor)
    writePreference(PCB_GRID_KEY, String(linesPerMajor))
  }

  const setSchematicGrid = (linesPerMajor: number) => {
    setSchematicGridState(linesPerMajor)
    writePreference(SCHEMATIC_GRID_KEY, String(linesPerMajor))
  }

  // The canvases call onBeginEdit once when a drag starts and then send every update of it here, so
  // the whole drag is one undo step. An action done in one go is a commitEdit instead.
  const updateLayout = (update: (layout: Layout) => Layout) => updateProject(layoutUpdate(update))
  const updateSchematic = (next: FullSchematic) => updateProject(schematicUpdate(next))

  const setSettings = (changes: Partial<Settings>) =>
    updateProject((p) => ({ ...p, settings: { ...p.settings, ...changes } }))

  const spacingViolations = useMemo(
    () => findSpacingViolations(layout.islands),
    [layout.islands],
  )
  const splitNets = useMemo(() => findSplitNets(layout.islands), [layout.islands])
  const problemNets = useMemo(() => findProblemNets(layout.islands), [layout.islands])
  const pinIssues = useMemo(() => findPinIssues(builtNetlist, layout, settings.isolation), [builtNetlist, layout, settings.isolation])

  const boardSize = useMemo(() => boundsOf(layout.islands.flatMap((i) => i.rects)), [layout.islands])

  const loadNetlist = (name: string, text: string, keepLayout: boolean) => {
    try {
      // The tab's project with a new netlist; it stays the same project, so it keeps its guid.
      updateProject((p) => (keepLayout ? reimportedProject(text, p) : importedProject(text, p.guid, DEFAULT_SETTINGS)))
      // A project not saved yet takes the netlist's name; a saved one keeps its file's.
      if (!projectFile(activeIdRef.current).location) renameTab(activeIdRef.current, name)
      // Old layouts belong to the old netlist.
      clearHistory()
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
    commitEdit(layoutUpdate((l) => ({ ...l, placements: l.placements.map((p) => (refs.includes(p.ref) ? change(p) : p)) })))
  }

  // Rotate and reset leads act on every selected part, each in place.
  const refsToEdit = selectedRefs(selection)

  const updatePcb = () => commitEdit(withSchematicNets)

  // Ground and power symbols turn and flip like parts do.
  const labelsToTurn = selectedWiring(selection).labels
  const canTurnSchematic = refsToEdit.length > 0 || labelsToTurn.length > 0

  const rotateSelected = (degrees: number, pane: Pane) => {
    if (pane === 'schematic') {
      if (!canTurnSchematic) return
      commitEdit(schematicUpdate(rotatedSelection(fullSchematic, builtNetlist, refsToEdit, labelsToTurn, degrees)))
      return
    }
    editPlacements(refsToEdit, (p) => ({ ...p, rotation: (p.rotation + degrees) % 360 }))
  }

  /** Mirrors each selected symbol in place; wires and labels on its pins go along. */
  const flipSelected = (axis: 'horizontal' | 'vertical') => {
    if (!canTurnSchematic) return
    commitEdit(schematicUpdate(flippedSelection(fullSchematic, builtNetlist, refsToEdit, labelsToTurn, axis)))
  }

  const changeLabel = (index: number, changes: Partial<NetLabel>) => commitEdit(schematicUpdate(withLabelChanged(fullSchematic, index, changes)))

  const resetLeads = () => editPlacements(refsToEdit, (p) => ({ ...p, leads: undefined }))

  const changePlacement = (ref: string, changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) =>
    editPlacements([ref], (p) => ({ ...p, ...changes }))

  /** Fills in or corrects a value, e.g. a transistor type the netlist left out. */
  const changeValue = (ref: string, value: string) =>
    commitEdit((p) => ({ ...p, netlist: withValues(p.netlist, [{ ref, value }]) }))

  const selectAll = () => {
    const wiring = { wires: fullSchematic.wires.map((_, i) => i), labels: fullSchematic.labels.map((_, i) => i), points: [] }
    setSelection(selectionOf(layout.placements.map((p) => p.ref), layout.islands.map((i) => i.net), wiring))
  }

  const selectedIsland = selection?.kind === 'island' ? layout.islands.find((i) => i.net === selection.net) : undefined
  const canRemoveRect = selectedIsland !== undefined && selectedIsland.rects.length > 1

  const removeRect = () => {
    if (selection?.kind !== 'island' || !canRemoveRect) return
    commitEdit(
      layoutUpdate((l) => ({
        ...l,
        islands: l.islands.map((i) =>
          i.net === selection.net ? { ...i, rects: i.rects.filter((_, k) => k !== selection.rectIndex) } : i,
        ),
      })),
    )
    setSelection({ ...selection, rectIndex: 0 })
  }

  const resetToGrid = async () => {
    if (!(await confirm('Reset to grid', 'Discard all manual placement and put everything back on a grid? This can be undone.', 'Reset'))) return
    commitEdit((p) => {
      const grid = createLayout(buildProjectNetlist(p))
      return { ...p, layout: keepFootprintChoices(grid, p.layout) }
    })
    setSelection(null)
    refit()
  }

  const openFootprintDialog = () => setFootprintDialogRefs(selectedRefs(selection))

  const applyFootprint = (refs: ReadonlySet<string>, footprint: string | undefined) =>
    commitEdit(layoutUpdate((l) => changeFootprints(netlist, l, refs, footprint)))

  const optimize = async () => {
    const strategy = findStrategy(settings.strategy)
    if (!(await confirm('Optimize', `Replace the current layout with a new ${strategy.label} layout? This can be undone.`, 'Replace layout'))) return
    let optimized: Layout
    try {
      optimized = strategy.run(builtNetlist, settings)
    } catch (e) {
      setError(errorText(e))
      return
    }
    commitEdit(layoutUpdate((l) => keepFootprintChoices(optimized, l)))
    setSelection(null)
    refit()
  }

  const exportLayout = () =>
    downloadText(`${tabName(activeId)}-isolation.svg`, exportSvg(layout.islands, settings.isolation), 'image/svg+xml')

  const exportLayoutDxf = () => downloadText(`${tabName(activeId)}-isolation.dxf`, exportDxf(layout.islands, settings.isolation), 'application/dxf')

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
        return showOpenDialog
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
                <span className="menu-heading">File</span>
                <button onClick={newProject} title="An empty project in a new tab">
                  <Icon name="newFile" />New project<kbd>Ctrl+N</kbd>
                </button>
                <button onClick={showOpenDialog} title="Open a project from this computer or Google Drive in a new tab">
                  <Icon name="open" />Open…<kbd>Ctrl+O</kbd>
                </button>
                <button onClick={() => saveTab(activeId)} title="Save this tab's project where it is saved; a new project asks where">
                  <Icon name="save" />Save<kbd>Ctrl+S</kbd>
                </button>
                <button onClick={() => saveTab(activeId, true)} title="Save under another name or somewhere else; the tab continues there">
                  <Icon name="save" />Save as…<kbd>Ctrl+Shift+S</kbd>
                </button>
                <MenuGroup icon="sample" label="Examples">
                  {EXAMPLES.map((example) => (
                    <button key={example.name} onClick={() => openInNewTab(example.open(), example.name)} title="A copy of this example in a new tab">
                      {example.name}
                    </button>
                  ))}
                </MenuGroup>
                <hr />
                <MenuGroup icon="importExport" label="Import / Export">
                  <button onClick={() => fileInputRef.current!.click()}><Icon name="file" />Import netlist…</button>
                  <button onClick={exportLayout} title="Cut paths with stroke width = isolation"><Icon name="export" />Export SVG</button>
                  <button onClick={exportLayoutDxf} title="Area to burn as closed contours in mm (board outline + copper as holes), ready to hatch in EzCad">
                    <Icon name="export" />Export DXF
                  </button>
                  <button onClick={copyShareLink} title="Copy a link that holds this whole project; opening it gives a copy in a new tab">
                    <Icon name="link" />Copy share link
                  </button>
                </MenuGroup>
                <MenuGroup icon="settings" label="Settings">
                  <button onClick={toggleTheme}>
                    <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
                    {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                  </button>
                </MenuGroup>
                <MenuGroup icon="help" label="Help">
                  <button onClick={() => setShowAiHelp(true)} title="Let an AI assistant edit this layout (MCP)">
                    <Icon name="ai" />AI assistant…
                    <span className={agentConnected ? 'agent-dot connected' : 'agent-dot'} aria-label={agentConnected ? 'Agent connected' : 'No agent'} />
                  </button>
                  <button onClick={() => setShowHelp(true)}>
                    <Icon name="help" />Keyboard and mouse
                  </button>
                </MenuGroup>
                {driveConfigured && (
                  <>
                    <hr />
                    <MenuGroup icon="user" label="Google account">
                      {signedIn ? (
                        <button onClick={signOut} title="Google Drive projects stay open here; they save again after signing in">
                          <Icon name="cloud" />Sign out
                        </button>
                      ) : (
                        <button onClick={signInToGoogle} title="Sign in to open and save projects in Google Drive">
                          <Icon name="cloud" />Sign in with Google
                        </button>
                      )}
                    </MenuGroup>
                  </>
                )}
              </div>
            )}
          </div>
          {!signedIn && tabs.some((tab) => projectFile(tab.id).location?.kind === 'drive') && (
            <button
              className="header-button"
              onClick={signInToGoogle}
              title="Google Drive documents are open; they save again after signing in, and changes stay here until then"
            >
              <Icon name="cloud" />Sign in to Google Drive
            </button>
          )}
          {/* Outside the menu, so they stay mounted while the file dialog is open. */}
          <input
            ref={uploadInputRef}
            type="file"
            accept=".json"
            hidden
            onChange={(e) => openUploadedFile(e.target.files?.[0])}
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
          tabs={tabs.map((tab) => ({
            id: tab.id,
            label: tab.name,
            unsaved: projectFile(tab.id).dirty,
            location: projectFile(tab.id).location?.kind ?? 'none',
          }))}
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
              <ComponentList
                netlist={schematicNetlist}
                selection={selection}
                onSelect={setSelection}
                pcb={view === 'split' ? { refsWithIssues: pinIssues.refsWithIssues, onChangeFootprint: openFootprintDialog } : undefined}
              />
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
                <span>
                  "{tabName(activeId)}" changed {fileConflict.location.kind === 'drive' ? 'in Google Drive' : 'on disk'},
                  and this tab has changes that were not saved.
                </span>
                <button className="header-button" onClick={() => loadSavedVersion(activeId, fileConflict.project, fileConflict.location)} title="Show the saved version; the changes here stay reachable with Undo">
                  Use saved version
                </button>
                <button className="header-button" onClick={() => keepRecoveryCopy(activeId, fileConflict.content, fileConflict.location)} title="Keep editing the changes here; saving overwrites the saved version">
                  Keep changes here
                </button>
              </div>
            ) : (
              projectFile(activeId).location &&
              !projectFile(activeId).checked && (
                <div className="sync-banner" role="status">
                  {projectFile(activeId).location?.kind === 'drive' ? (
                    <>
                      <span>Showing the recovery copy of "{tabName(activeId)}"; sign in to compare it with Google Drive and save it there.</span>
                      <button className="header-button" onClick={() => checkSaved(activeId, true)}>
                        <Icon name="cloud" />Sign in to Google Drive
                      </button>
                    </>
                  ) : (
                    <>
                      <span>Showing the recovery copy of "{tabName(activeId)}"; the file itself was not checked yet.</span>
                      <button className="header-button" onClick={() => checkSaved(activeId, true)} title="Allow access to the file and compare it with the recovery copy">
                        <Icon name="open" />Check file
                      </button>
                    </>
                  )}
                </div>
              )
            )}
            {pinsNotInPcb.length > 0 && (
              <div className="sync-banner" role="status">
                <span title={pinsNotInPcb.join(' ')}>
                  The schematic has changes the PCB does not have yet: {pinsNotInPcb.length} pin{pinsNotInPcb.length === 1 ? '' : 's'} connected differently.
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
                    <RailMenu icon="grid" label="Grid" title="Grid settings">
                      <GridSettings linesPerMajor={schematicGrid} onChange={setSchematicGrid} />
                    </RailMenu>
                    <RailMenu icon="eye" label="View" title="Choose what is drawn">
                      <LayerToggles info={SCHEMATIC_LAYERS} layers={schematicLayers} onChange={setSchematicLayers} />
                    </RailMenu>
                  </div>
                </nav>
                <div className="canvas-frame">
                  <SchematicView
                    netlist={schematicNetlist}
                    schematic={fullSchematic}
                    nets={schematicNets}
                    onChange={updateSchematic}
                    onBeginEdit={beginEdit}
                    selection={selection}
                    onSelect={setSelection}
                    tool={schematicTool}
                    fitRequest={fitRequest}
                    layers={schematicLayers}
                    gridLinesPerMajor={schematicGrid}
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
                    <RailMenu icon="grid" label="Grid" title="Grid settings">
                      <GridSettings linesPerMajor={pcbGrid} onChange={setPcbGrid} />
                    </RailMenu>
                    <RailMenu icon="eye" label="View" title="Choose what is drawn">
                      <LayerToggles info={PCB_LAYERS} layers={layers} onChange={setLayers} opacityNote=" (below 50% the layer ignores clicks)" />
                    </RailMenu>
                  </div>
                </nav>
                <div className="canvas-frame">
                  <Canvas
                    netlist={builtNetlist}
                    layout={layout}
                    onLayoutChange={updateLayout}
                    onBeginEdit={beginEdit}
                    selection={selection}
                    onSelect={setSelection}
                    snap={settings.snap}
                    isolation={settings.isolation}
                    problemNets={problemNets}
                    fitRequest={fitRequest}
                    layers={layers}
                    tool={tool}
                    moveMode={moveMode}
                    rectHandles={findStrategy(settings.strategy).rectHandles}
                    gridLinesPerMajor={pcbGrid}
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
                  <select value={settings.strategy} onChange={(e) => setSettings({ strategy: findStrategy(e.target.value).id })}>
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
                openPins={pinIssues.open}
                shortedPins={pinIssues.short}
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
                  pcb={{ refsWithIssues: pinIssues.refsWithIssues, onChangeFootprint: openFootprintDialog }}
                />
              </Section>
            )}
          </aside>
        )}
      </div>

      {showHelp && <HelpDialog onClose={() => setShowHelp(false)} />}
      {showAiHelp && <AiHelpDialog agentConnected={agentConnected} onClose={() => setShowAiHelp(false)} />}
      {fileDialog && (
        <FileDialog
          mode={fileDialog.mode}
          name={fileDialog.mode === 'save' ? fileDialog.name : undefined}
          recent={recentDocuments()}
          signedIn={signedIn}
          onSignIn={signInToGoogle}
          onOpenRecent={openRecent}
          onOpenDrive={openFromDrive}
          onOpenLocal={openProjectFile}
          onSave={(choice) => fileDialog.mode === 'save' && fileDialog.resolve(choice)}
          onClose={closeFileDialog}
        />
      )}
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
