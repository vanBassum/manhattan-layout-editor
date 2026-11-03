// The project tabs of this browser tab: which are open, which one is shown with its project, each
// tab's undo history, and the recovery copy of every change.

import { useEffect, useRef, useState } from 'react'
import { emptyProject } from '../documents/projectFormat'
import {
  UNTITLED,
  loadTabs,
  newTabId,
  onRemoteChange,
  readProject,
  rememberActiveTab,
  removeProject,
  setSavedProject,
  writeProject,
  writeTabs,
  type DriveRevision,
  type ProjectLocation,
  type ProjectTab,
  type RemoteChange,
} from '../documents/projectStore'
import type { Project } from '../model/types'
import { NO_HISTORY, snapshotOf, stepHistory, withEdit, type History, type Snapshot } from '../model/undoHistory'

const RECOVERY_COPY_DELAY_MS = 300

export type UndoDirection = 'undo' | 'redo'

/** The tab session as the rest of the editor uses it. */
export type TabSession = ReturnType<typeof useTabs>

/** `onEnterTab` runs whenever another tab, or a fresh project in the last one, is shown. */
export function useTabs(onEnterTab: () => void) {
  const [initialTabs] = useState(loadTabs)
  const [tabs, setTabs] = useState(initialTabs.tabs)
  const [activeId, setActiveId] = useState(initialTabs.activeId)
  const [project, setProject] = useState<Project>(() => readProject(initialTabs.activeId))

  // The latest tabs, shown tab and its project, also between a change and the next render: agent
  // commands, file checks and saves read them after an await. Each is set only in this hook, in the
  // same call as its state, so it is never behind what is rendered.
  const tabsRef = useRef(tabs)
  const activeIdRef = useRef(activeId)
  const projectRef = useRef(project)

  /** Shows `next` as the open tabs, without storing them. */
  const showTabs = (next: ProjectTab[]) => {
    tabsRef.current = next
    setTabs(next)
  }

  /** Every change to the open tabs made in this browser tab goes through here. */
  const replaceTabs = (next: ProjectTab[]) => {
    showTabs(next)
    writeTabs(next)
  }

  /** Every change to the shown project goes through here. */
  const showProject = (next: Project) => {
    projectRef.current = next
    setProject(next)
  }

  // ---------- Undo ----------

  /** Undo history of the shown tab. */
  const history = useRef<History>(NO_HISTORY)
  /** Undo history of the tabs that are not shown, so switching back keeps it. */
  const parkedHistory = useRef(new Map<string, History>())

  /** Changes the shown project without a new undo step: a setting, or a drag's updates after beginEdit. */
  const updateProject = (update: (current: Project) => Project) => showProject(update(projectRef.current))

  /** Starts a change that arrives in several updates, such as a drag, as one undo step. */
  const beginEdit = () => {
    history.current = withEdit(history.current, snapshotOf(projectRef.current))
  }

  /** Changes the shown project as one undo step. */
  const commitEdit = (update: (current: Project) => Project) => {
    beginEdit()
    updateProject(update)
  }

  const clearHistory = () => {
    history.current = NO_HISTORY
  }

  /** Undo or redo on the shown tab; false when there is nothing to step to. */
  const stepShownTab = (direction: UndoDirection): boolean => {
    const stepped = stepHistory(history.current, snapshotOf(projectRef.current), direction)
    if (!stepped) return false
    history.current = stepped.history
    updateProject((current) => ({ ...current, ...stepped.restored }))
    return true
  }

  /** Undo or redo on a tab that is not shown: straight in storage, with its own history. Returns the tab's project. */
  const stepHiddenTab = (id: string, stored: Project, direction: UndoDirection): Project => {
    const stepped = stepHistory(parkedHistory.current.get(id) ?? NO_HISTORY, snapshotOf(stored), direction)
    if (!stepped) return stored
    parkedHistory.current.set(id, stepped.history)
    const updated = { ...stored, ...stepped.restored }
    writeProject(id, updated)
    return updated
  }

  /** An undoable change to a tab that is not shown, straight in storage. Returns the changed project. */
  const changeHiddenTab = (id: string, stored: Project, changes: Partial<Snapshot>): Project => {
    parkedHistory.current.set(id, withEdit(parkedHistory.current.get(id) ?? NO_HISTORY, snapshotOf(stored)))
    const updated = { ...stored, ...changes }
    writeProject(id, updated)
    return updated
  }

  // ---------- Tabs ----------

  /** The name of tab `id`'s project: its file's name, or before saving the name it started with. */
  const tabName = (id: string) => tabsRef.current.find((t) => t.id === id)?.name ?? UNTITLED

  /** The project of tab `id`, including changes still waiting to be written to the recovery copy. */
  const shownProject = (id: string) => (id === activeIdRef.current ? projectRef.current : readProject(id))

  const renameTab = (id: string, name: string) => replaceTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, name } : t)))

  /** Shows `id` with its own undo history; the shown tab is left as it is in storage. */
  const enterTab = (id: string, next: Project) => {
    history.current = parkedHistory.current.get(id) ?? NO_HISTORY
    parkedHistory.current.delete(id)
    showProject(next)
    activeIdRef.current = id
    setActiveId(id)
    rememberActiveTab(id)
    onEnterTab()
  }

  /** Saves the shown project and its undo history, then shows `id` with its own. */
  const showTab = (id: string, next: Project) => {
    const leaving = activeIdRef.current
    writeProject(leaving, projectRef.current)
    parkedHistory.current.set(leaving, history.current)
    enterTab(id, next)
  }

  const switchTab = (id: string) => {
    if (id !== activeIdRef.current) showTab(id, readProject(id))
  }

  const openInNewTab = (opened: Project, name: string, location?: ProjectLocation, driveRevision?: DriveRevision) => {
    const id = newTabId()
    setSavedProject(id, opened, location, driveRevision)
    replaceTabs([...tabsRef.current, { id, name }])
    showTab(id, opened)
  }

  const newProject = () => openInNewTab(emptyProject(projectRef.current.settings), UNTITLED)

  /** Closes tab `id` without asking: its unsaved changes are lost. */
  const closeSavedTab = (id: string) => {
    // The latest tabs: the question whether to save first may have taken a while.
    const before = tabsRef.current
    const remaining = before.filter((t) => t.id !== id)
    if (remaining.length === 0) {
      // Always keep one tab: closing the last one leaves a fresh, empty project in it.
      const created = emptyProject(projectRef.current.settings)
      setSavedProject(id, created)
      replaceTabs([{ id, name: UNTITLED }])
      enterTab(id, created)
      return
    }
    replaceTabs(remaining)
    if (id === activeIdRef.current) {
      const neighbour = remaining[Math.max(0, before.findIndex((t) => t.id === id) - 1)]
      showTab(neighbour.id, readProject(neighbour.id))
    }
    parkedHistory.current.delete(id)
    removeProject(id)
  }

  // ---------- Other browser tabs and the recovery copy ----------

  // The agent only talks to the most recently opened browser tab; other browser tabs showing the
  // same project follow along. The store skips project writes that change nothing, so browser tabs
  // do not echo each other.
  const handleRemoteChange = useRef<(change: RemoteChange) => void>(() => {})
  handleRemoteChange.current = (change) => {
    if (change.kind === 'tabs') {
      if (change.tabs.length === 0) return
      // Already stored by the other browser tab; storing them again would send them back.
      showTabs(change.tabs)
      // Closed elsewhere: enterTab, unlike showTab, does not save it on the way out, which would bring it back.
      if (!change.tabs.some((t) => t.id === activeIdRef.current)) enterTab(change.tabs[0].id, readProject(change.tabs[0].id))
    } else if (change.id === activeIdRef.current) {
      showProject(change.project)
    }
  }
  useEffect(() => onRemoteChange((change) => handleRemoteChange.current(change)), [])

  useEffect(() => {
    const timer = setTimeout(() => writeProject(activeId, project), RECOVERY_COPY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [project, activeId])

  // The last change may still wait for the timer above.
  useEffect(() => {
    const flush = () => writeProject(activeIdRef.current, projectRef.current)
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  return {
    tabs,
    activeId,
    project,
    tabsRef: tabsRef as { readonly current: ProjectTab[] },
    activeIdRef: activeIdRef as { readonly current: string },
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
    stepShownTab,
    stepHiddenTab,
    changeHiddenTab,
  }
}
