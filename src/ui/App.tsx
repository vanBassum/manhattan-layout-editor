import { useEffect, useMemo, useRef, useState } from 'react'
import { connectAgentBridge } from '../agent/agentBridge'
import { buildNetlist, buildProjectNetlist } from '../model/definitions'
import { importedProject, reimportedProject } from '../model/netlistImport'
import { runAgentCommand, type AgentTab } from '../agent/agentDispatch'
import { Canvas, DEFAULT_PCB_GRID_LINES_PER_MAJOR, type MoveMode, type Tool } from './pcb/Canvas'
import { exportDxf } from '../export/exportDxf'
import { downloadText } from './download'
import { FileDialog } from './FileDialog'
import { errorText } from '../errorText'
import { exportSvg } from '../export/exportSvg'
import { FootprintDialog } from './FootprintDialog'
import { boundsOf } from '../model/geometry'
import { chooseFootprints, createLayout, findPinIssues, findSpacingViolations, findSplitNets } from '../model/layout'
import { withValues } from '../model/netlist'
import { findBuildStyle } from '../model/buildStyles'
import { AiHelpDialog, HelpDialog, QuestionDialog, type Question } from './dialogs'
import { Icon } from './icons'
import { ComponentList, PartProperties, SchematicCheck, Section, SelectionDetails, Validation } from './panels'
import { DEFAULT_SETTINGS } from '../documents/projectFormat'
import { projectFile, restoreErrors } from '../documents/projectStore'
import { canvasToPng } from './pcb/screenshot'
import { shareLinkOf, takeSharedProject } from '../documents/shareLink'
import { selectedRefs, selectedWiring, selectionOf } from '../model/selection'
import { screenshotHidden } from './pcb/hiddenScreenshot'
import {
  deriveNets,
  flippedSelection,
  pinsWithOtherNet,
  placedParts,
  rotatedSelection,
  unconnectedPins,
  withLabelChanged,
  withSchematicNets,
} from '../model/schematic'
import { SchematicView, type SchematicTool } from './schematic/SchematicView'
import type { Layout, NetLabel, Placement, Project, Schematic, Selection, Settings, Simulation } from '../model/types'
import { ProjectTabs } from './ProjectTabs'
import { AppMenu } from './AppMenu'
import { CanvasBanners } from './CanvasBanners'
import { ALL_LAYERS, DEFAULT_SCHEMATIC_LAYERS } from './layers'
import { PcbSettings } from './PcbSettings'
import { PcbToolRail } from './PcbToolRail'
import {
  DEFAULT_SCHEMATIC_GRID_LINES_PER_MAJOR,
  LAYERS_KEY,
  parseGridLinesPerMajor,
  parseLayerViews,
  parseTheme,
  parseView,
  PCB_GRID_KEY,
  SCHEMATIC_GRID_KEY,
  SCHEMATIC_LAYERS_KEY,
  THEME_KEY,
  usePreference,
  VIEW_KEY,
  type ViewMode,
} from './preferences'
import { SchematicToolRail } from './SchematicToolRail'
import { SimulationPanel } from './SimulationPanel'
import { RightPaneSwitch, type RightPane } from './RightPaneSwitch'
import { useShortcuts } from './shortcuts'
import { useDocuments } from './useDocuments'
import { useTabs, type UndoDirection } from './useTabs'

type Pane = 'schematic' | 'layout'

/** The name of a project opened from a share link, until it is saved. */
const SHARED_PROJECT = 'Shared project'

/** A project update that changes the layout with `update`. */
const layoutUpdate =
  (update: (layout: Layout) => Layout) =>
  (project: Project): Project => ({ ...project, layout: update(project.layout) })

/** A project update that replaces the schematic. It leaves the PCB alone: "Update PCB" takes its nets over when the user is ready. */
const schematicUpdate =
  (schematic: Schematic) =>
  (project: Project): Project => ({ ...project, schematic })

export function App() {
  const [selection, setSelection] = useState<Selection>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [moveMode, setMoveMode] = useState<MoveMode>('part')
  const [view, setView] = usePreference(VIEW_KEY, parseView)
  /** The pane last clicked in; keyboard shortcuts act on it when both are shown. */
  const [activePane, setActivePane] = useState<Pane>(() => (view === 'schematic' ? 'schematic' : 'layout'))
  const [schematicTool, setSchematicTool] = useState<SchematicTool>('select')
  const [rightPane, setRightPane] = useState<RightPane>('pcb')
  const showView = (mode: ViewMode) => {
    setView(mode)
    if (mode !== 'split') setActivePane(mode)
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
    setTabName,
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
  const [theme, setTheme] = usePreference(THEME_KEY, parseTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  /** Parts checked when the footprint dialog opened; null while it is closed. */
  const [footprintDialogRefs, setFootprintDialogRefs] = useState<string[] | null>(null)
  const [layers, setLayers] = usePreference(LAYERS_KEY, (stored) => parseLayerViews(stored, ALL_LAYERS))
  const [schematicLayers, setSchematicLayers] = usePreference(SCHEMATIC_LAYERS_KEY, (stored) => parseLayerViews(stored, DEFAULT_SCHEMATIC_LAYERS))
  const [pcbGrid, setPcbGrid] = usePreference(PCB_GRID_KEY, (stored) => parseGridLinesPerMajor(stored, DEFAULT_PCB_GRID_LINES_PER_MAJOR))
  const [schematicGrid, setSchematicGrid] = usePreference(SCHEMATIC_GRID_KEY, (stored) =>
    parseGridLinesPerMajor(stored, DEFAULT_SCHEMATIC_GRID_LINES_PER_MAJOR),
  )
  const { netlist, layout, schematic, settings } = project
  const builtNetlist = useMemo(() => buildNetlist(netlist, project.definitions), [netlist, project.definitions])
  const schematicNets = useMemo(
    () => deriveNets(netlist, placedParts(schematic.placements, builtNetlist), schematic),
    [netlist, builtNetlist, schematic],
  )
  /** The schematic's own nets, drawn in the schematic; the PCB keeps `builtNetlist` until it is updated. */
  const schematicNetlist = useMemo(
    () => buildNetlist(schematicNets.netlist, project.definitions),
    [schematicNets, project.definitions],
  )
  const pinsNotInPcb = useMemo(() => pinsWithOtherNet(netlist, schematicNets.netlist), [netlist, schematicNets])
  const schematicOpenPins = useMemo(() => unconnectedPins(schematicNets.netlist), [schematicNets])

  const stepShownTab = (direction: UndoDirection) => {
    if (tabSession.stepShownTab(direction)) setSelection(null)
  }
  const undo = () => stepShownTab('undo')
  const redo = () => stepShownTab('redo')

  /** Tab `id` as an agent command works on it. */
  const agentTab = (id: string): AgentTab => {
    const shown = id === activeIdRef.current
    const stored = shownProject(id)
    return {
      project: stored,
      change: (changes) => {
        if (!shown) return changeHiddenTab(id, stored, changes)
        commitEdit((current) => ({ ...current, ...changes }))
        // A selection names schematic wires and labels by index; new ones mean other things.
        if (changes.schematic) setSelection(null)
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
    runAgentCommand(command, args, {
      tabs: tabsRef.current.map((t) => ({ id: t.id, name: tabName(t.id) })),
      shownId: activeIdRef.current,
      tab: agentTab,
    })

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
    if (!tabs.some((t) => t.id === id)) return
    if (projectFile(id).dirty) {
      const choice = await ask({
        title: `Save changes to "${tabName(id)}"?`,
        text: 'Closing without saving throws the changes away.',
        choices: [{ answer: 'discard', label: "Don't save" }, { answer: 'cancel', label: 'Cancel' }, { answer: 'save', label: 'Save' }],
        cancel: 'cancel',
      })
      if (choice === 'cancel' || (choice === 'save' && !(await saveTab(id)))) return
    }
    closeSavedTab(id)
  }

  // The canvases call onBeginEdit once when a drag starts and then send every update of it here, so
  // the whole drag is one undo step. An action done in one go is a commitEdit instead.
  const updateLayout = (update: (layout: Layout) => Layout) => updateProject(layoutUpdate(update))
  const updateSchematic = (next: Schematic) => updateProject(schematicUpdate(next))

  const setSettings = (changes: Partial<Settings>) =>
    updateProject((p) => ({ ...p, settings: { ...p.settings, ...changes } }))

  const spacingViolations = useMemo(
    () => findSpacingViolations(layout.islands),
    [layout.islands],
  )
  const splitNets = useMemo(() => findSplitNets(layout.islands), [layout.islands])
  // The same nets as findProblemNets, from the two checks already done above.
  const problemNets = useMemo(() => new Set([...spacingViolations, ...splitNets]), [spacingViolations, splitNets])
  const pinIssues = useMemo(() => findPinIssues(builtNetlist, layout, settings.isolation), [builtNetlist, layout, settings.isolation])

  const boardSize = useMemo(() => boundsOf(layout.islands.flatMap((i) => i.rects)), [layout.islands])

  const loadNetlist = (name: string, text: string, keepLayout: boolean) => {
    try {
      // The tab's project with a new netlist; it stays the same project, so it keeps its guid.
      updateProject((p) => (keepLayout ? reimportedProject(text, p) : importedProject(text, p.guid, DEFAULT_SETTINGS)))
      // A project not saved yet takes the netlist's name; a saved one keeps its file's.
      if (!projectFile(activeIdRef.current).location) setTabName(activeIdRef.current, name)
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
      commitEdit(schematicUpdate(rotatedSelection(schematic, builtNetlist, refsToEdit, labelsToTurn, degrees)))
      return
    }
    editPlacements(refsToEdit, (p) => ({ ...p, rotation: (p.rotation + degrees) % 360 }))
  }

  /** Mirrors each selected symbol in place; wires and labels on its pins go along. */
  const flipSelected = (axis: 'horizontal' | 'vertical') => {
    if (!canTurnSchematic) return
    commitEdit(schematicUpdate(flippedSelection(schematic, builtNetlist, refsToEdit, labelsToTurn, axis)))
  }

  const changeLabel = (index: number, changes: Partial<NetLabel>) => commitEdit(schematicUpdate(withLabelChanged(schematic, index, changes)))

  const resetLeads = () => editPlacements(refsToEdit, (p) => ({ ...p, leads: undefined }))

  const changePlacement = (ref: string, changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) =>
    editPlacements([ref], (p) => ({ ...p, ...changes }))

  /** Fills in or corrects a value, e.g. a transistor type the netlist left out. */
  const changeValue = (ref: string, value: string) =>
    commitEdit((p) => ({ ...p, netlist: withValues(p.netlist, [{ ref, value }]) }))

  const changeSimulation = (simulation: Simulation) => commitEdit((p) => ({ ...p, simulation }))

  const selectAll = () => {
    const wiring = { wires: schematic.wires.map((_, i) => i), labels: schematic.labels.map((_, i) => i), points: [] }
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
    commitEdit((p) => ({ ...p, layout: createLayout(buildProjectNetlist(p)) }))
    setSelection(null)
    refit()
  }

  const openFootprintDialog = () => setFootprintDialogRefs(selectedRefs(selection))

  const applyFootprint = (refs: ReadonlySet<string>, footprint: string | undefined) =>
    commitEdit((p) => ({ ...p, ...chooseFootprints(p, refs, footprint) }))

  const exportLayout = () =>
    downloadText(`${tabName(activeId)}-isolation.svg`, exportSvg(layout.islands, settings.isolation), 'image/svg+xml')

  const exportLayoutDxf = () => downloadText(`${tabName(activeId)}-isolation.dxf`, exportDxf(layout.islands, settings.isolation), 'application/dxf')

  useShortcuts({
    save: () => saveTab(activeId),
    saveAs: () => saveTab(activeId, true),
    open: showOpenDialog,
    newProject,
    undo,
    redo,
    selectAll,
    rotate: () => rotateSelected(90, activePane),
    rotateFine: () => rotateSelected(15, activePane),
    removeRect,
    clearSelection: () => setSelection(null),
    fit: refit,
    selectTool: () => {
      setTool('select')
      setSchematicTool('select')
    },
    wireTool: () => setSchematicTool('wire'),
    labelTool: () => setSchematicTool('label'),
    panTool: () => setTool('pan'),
    flipHorizontal: () => {
      if (activePane === 'schematic') flipSelected('horizontal')
    },
    flipVertical: () => {
      if (activePane === 'schematic') flipSelected('vertical')
    },
    toggleMoveMode: () => setMoveMode((mode) => (mode === 'part' ? 'body' : 'part')),
  })

  return (
    <div className="app">
      {/* Same columns as the workspace below, so the project tabs start where the canvas does. */}
      <header className={`header view-${view}`}>
        <div className="header-start">
          <AppMenu
            agentConnected={agentConnected}
            signedIn={signedIn}
            theme={theme}
            onNewProject={newProject}
            onOpen={showOpenDialog}
            onSave={() => saveTab(activeId)}
            onSaveAs={() => saveTab(activeId, true)}
            onOpenInNewTab={openInNewTab}
            onImportNetlist={() => fileInputRef.current!.click()}
            onExportSvg={exportLayout}
            onExportDxf={exportLayoutDxf}
            onCopyShareLink={copyShareLink}
            onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            onShowAiHelp={() => setShowAiHelp(true)}
            onShowHelp={() => setShowHelp(true)}
            onSignIn={signInToGoogle}
          />
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
            label: tabName(tab.id),
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

      {/* The simulation takes the PCB's place, sidebar included. */}
      <div className={`workspace view-${view}${view !== 'schematic' && rightPane === 'simulation' ? ' simulating' : ''}`}>
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
                labels={schematic.labels}
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
          <CanvasBanners
            error={error}
            onDismissError={() => setError('')}
            notice={notice}
            onDismissNotice={() => setNotice('')}
            tabName={tabName(activeId)}
            file={projectFile(activeId)}
            conflict={fileConflict?.id === activeId ? fileConflict : undefined}
            onUseSavedVersion={(conflict) => loadSavedVersion(activeId, conflict.project, conflict.driveRevision)}
            onKeepChangesHere={(conflict) => keepRecoveryCopy(activeId, conflict.content, conflict.driveRevision)}
            onCheckSaved={() => checkSaved(activeId, true)}
            pinsNotInPcb={pinsNotInPcb}
            onUpdatePcb={updatePcb}
          />
          <div className="canvas-panes">
            {view !== 'layout' && (
              <section className="canvas-pane" onPointerDownCapture={() => setActivePane('schematic')}>
                <SchematicToolRail
                  tool={schematicTool}
                  onToolChange={setSchematicTool}
                  onFit={refit}
                  canTurn={canTurnSchematic}
                  onRotate={() => rotateSelected(90, 'schematic')}
                  onFlip={flipSelected}
                  gridLinesPerMajor={schematicGrid}
                  onGridChange={setSchematicGrid}
                  layers={schematicLayers}
                  onLayersChange={setSchematicLayers}
                />
                <div className="canvas-frame">
                  <SchematicView
                    netlist={schematicNetlist}
                    schematic={schematic}
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
            {view !== 'schematic' && rightPane === 'simulation' && (
              <section className="canvas-pane">
                <RightPaneSwitch pane={rightPane} onChange={setRightPane} />
                <div className="simulation-frame">
                  {/* Keyed by tab: a run belongs to the project it ran. */}
                  <SimulationPanel
                    key={activeId}
                    netlist={schematicNets.netlist}
                    definitions={project.definitions}
                    simulation={project.simulation}
                    onChange={changeSimulation}
                  />
                </div>
              </section>
            )}
            {view !== 'schematic' && rightPane === 'pcb' && (
              <section className="canvas-pane" onPointerDownCapture={() => setActivePane('layout')}>
                <RightPaneSwitch pane={rightPane} onChange={setRightPane} />
                <PcbToolRail
                  tool={tool}
                  onToolChange={setTool}
                  onFit={refit}
                  moveMode={moveMode}
                  onMoveModeChange={setMoveMode}
                  partsSelected={refsToEdit.length > 0}
                  onRotate={() => rotateSelected(90, 'layout')}
                  onResetLeads={resetLeads}
                  onChangeFootprint={openFootprintDialog}
                  gridLinesPerMajor={pcbGrid}
                  onGridChange={setPcbGrid}
                  layers={layers}
                  onLayersChange={setLayers}
                />
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
                    rectHandles={findBuildStyle(settings.buildStyle).rectHandles}
                    gridLinesPerMajor={pcbGrid}
                  />
                </div>
              </section>
            )}
          </div>
        </main>

        {view !== 'schematic' && rightPane === 'pcb' && (
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
            <PcbSettings settings={settings} onChange={setSettings}onResetToGrid={resetToGrid} boardSize={boardSize} />
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
          signedIn={signedIn}
          onSignIn={signInToGoogle}
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
