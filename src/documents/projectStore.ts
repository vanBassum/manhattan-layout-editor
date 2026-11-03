// The open projects (one per tab) live in IndexedDB as recovery copies: every change lands there,
// so a crash or reload loses nothing. The open tabs are this computer's own work session; where a
// project is saved is its location: a file on this computer, a document in Google Drive, or none
// yet. Each record keeps the content as last saved or opened, which tells whether the tab has
// unsaved changes and whether the saved document changed since.
//
// The editor reads and writes a copy in memory, loaded once before it starts; IndexedDB is written
// behind it. Other browser tabs hear about changes over a BroadcastChannel. Each browser tab
// remembers its own active project in sessionStorage, so two browser tabs can work on different
// projects without overwriting each other.

import { errorText } from '../errorText'
import { migrateGappedIslands } from '../model/migrations/migrateIslands'
import type { Project } from '../model/types'
import { firstVisitExample } from './examples'
import { checkedProject, projectNameOf, projectToFile, readSavedProject } from './projectFormat'

/**
 * An open tab. A tab whose project is saved somewhere is called by that document (see nameOfTab);
 * only a project saved nowhere (new, an example, a share link, downloaded) has a `name` of its own.
 * Where its project is saved is its ProjectFile.
 */
export interface ProjectTab {
  id: string
  name?: string
}

/** Where a project is saved: a file on this computer, or a document in Google Drive. */
export type ProjectLocation = { kind: 'local'; handle: FileSystemFileHandle } | { kind: 'drive'; fileId: string }

/** What Google Drive said of a document when it was last saved, opened or checked here. */
export interface DriveRevision {
  version: string
  /** The project's name: the file's name without its extension. */
  name: string
}

/**
 * Where a tab's project is saved and how it stands against that document. The store owns it, per
 * tab id (projectFile); the document also names the tab (nameOfTab).
 */
export interface ProjectFile {
  /** None for a project that was never saved (or saved by download). */
  location?: ProjectLocation
  /** Document content as last saved or opened. */
  savedContent: string
  /** The Drive document's revision as last saved, opened or checked; only for a location in Drive. */
  driveRevision?: DriveRevision
  /** The project differs from `savedContent`. */
  dirty: boolean
  /** The saved document was compared with `savedContent` in this session. Always true without a location. */
  checked: boolean
}

interface OpenProject extends ProjectFile {
  project: Project
  /** File content of `project`, to skip writes that change nothing. */
  content: string
}

/** What IndexedDB keeps per tab. */
interface StoredProject {
  project: Project
  savedContent: string
  location?: ProjectLocation
  driveRevision?: DriveRevision
  /** Before locations: the linked file. */
  handle?: FileSystemFileHandle
}

/**
 * Until November 2026 a stored Drive location also held Drive's version as last saved or opened,
 * and the document's name was its tab's.
 */
type StoredRecord = Omit<StoredProject, 'location'> & { location?: ProjectLocation & { version?: string } }

/**
 * Tab `tab`'s record as this version keeps it: an old Drive location's version, with the name its
 * tab had, becomes the record's revision.
 */
function convertedRecord(stored: StoredRecord, tab: ProjectTab): StoredProject {
  const { location, ...rest } = stored
  if (location?.kind !== 'drive' || location.version === undefined) return { ...rest, location }
  if (tab.name === undefined) throw new Error('its Google Drive document has no name')
  return { ...rest, location: { kind: 'drive', fileId: location.fileId }, driveRevision: { version: location.version, name: tab.name } }
}

type Message = { kind: 'tabs'; tabs: ProjectTab[] } | { kind: 'project'; id: string; stored: StoredProject } | { kind: 'removed'; id: string }

/** Something changed in another browser tab. */
export type RemoteChange = { kind: 'tabs'; tabs: ProjectTab[] } | { kind: 'project'; id: string; project: Project }

const DB_NAME = 'manhattan-layout-editor'
const PROJECTS_STORE = 'projects'
const META_STORE = 'meta'
const TABS_RECORD = 'tabs'
/** Until November 2026 the Open dialog listed recent documents; their list is cleared on the next start. */
const OLD_RECENT_RECORD = 'recent'
const ACTIVE_TAB_KEY = 'manhattan-layout-editor/active-tab'

/** Why tabs from the last session could not be opened again; the editor shows them once it is up. */
export const restoreErrors: string[] = []

const openProjects = new Map<string, OpenProject>()
let openTabs: ProjectTab[] = []
let db: IDBDatabase | null = null
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DB_NAME)
const fileListeners = new Set<() => void>()
const remoteListeners = new Set<(change: RemoteChange) => void>()

export const newTabId = () => Math.random().toString(36).slice(2, 10)

// --- IndexedDB -----------------------------------------------------------------------------------

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function openDatabase(): Promise<IDBDatabase> {
  const opening = indexedDB.open(DB_NAME, 1)
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(PROJECTS_STORE)
    opening.result.createObjectStore(META_STORE)
  }
  return request(opening)
}

// Storage full or disabled: the editor keeps working from memory, so writes fail silently.
function put(storeName: string, key: string, value: unknown) {
  try {
    db?.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key)
  } catch {}
}

function remove(storeName: string, key: string) {
  try {
    db?.transaction(storeName, 'readwrite').objectStore(storeName).delete(key)
  } catch {}
}

/** Other browser tabs only follow along; failing to tell them must not stop a write. */
function tell(message: Message) {
  try {
    channel?.postMessage(message)
  } catch {}
}

const storedOf = (open: OpenProject): StoredProject => ({
  project: open.project,
  savedContent: open.savedContent,
  location: open.location,
  driveRevision: open.driveRevision,
})

function persist(id: string) {
  const open = openProjects.get(id)
  if (!open) return
  const stored = storedOf(open)
  put(PROJECTS_STORE, id, stored)
  tell({ kind: 'project', id, stored })
}

function remember(id: string, stored: StoredProject, checked: boolean) {
  const content = projectToFile(stored.project)
  openProjects.set(id, {
    ...stored,
    content,
    dirty: content !== stored.savedContent,
    checked: checked || !stored.location,
  })
}

let fileStatusChanges = 0

function notifyFiles() {
  fileStatusChanges++
  fileListeners.forEach((listener) => listener())
}

// --- Before IndexedDB: localStorage --------------------------------------------------------------

// v5: islands touch; the isolation cut runs along their shared edges (see model/migrations/migrateIslands.ts).
const LEGACY_PROJECT_PREFIX = 'manhattan-layout-editor/project-v5'
// v3: islands with isolation gaps between them.
const V3_PROJECT_PREFIX = 'manhattan-layout-editor/project-v3'
const LEGACY_TABS_KEY = 'manhattan-layout-editor/tabs-v1'

function readLegacyJson(key: string): unknown {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? null : JSON.parse(stored)
  } catch {
    return null
  }
}

/** Tab `id`'s project as stored before IndexedDB, in the v5 or else the v3 layout; null when neither is stored. */
function readLegacyProject(id: string): Project | null {
  const v5 = readLegacyJson(`${LEGACY_PROJECT_PREFIX}/${id}`)
  if (v5 !== null) return checkedProject(v5)
  const v3 = readLegacyJson(`${V3_PROJECT_PREFIX}/${id}`)
  return v3 === null ? null : migrateGappedIslands(checkedProject(v3))
}

/**
 * The tabs and projects from before IndexedDB, or from before tabs (a single v3 project under the
 * bare prefix). localStorage is left as it is, as a way back.
 */
function readLegacyTabs(): { tabs: ProjectTab[]; projects: Map<string, Project> } {
  const listed = readLegacyJson(LEGACY_TABS_KEY)
  const tabs = Array.isArray(listed) ? (listed as ProjectTab[]).filter((t) => typeof t?.id === 'string') : []
  const projects = new Map<string, Project>()
  for (const tab of tabs) {
    try {
      const project = readLegacyProject(tab.id)
      if (project) projects.set(tab.id, project)
      else restoreErrors.push(`Could not open "${tab.name}" again: its project is missing.`)
    } catch (e) {
      restoreErrors.push(`Could not open "${tab.name}" again: ${errorText(e)}.`)
    }
  }
  if (tabs.length === 0) {
    const single = readLegacyJson(V3_PROJECT_PREFIX)
    if (single !== null) {
      try {
        const id = newTabId()
        projects.set(id, migrateGappedIslands(checkedProject(single)))
        tabs.push({ id, name: UNTITLED })
      } catch (e) {
        restoreErrors.push(`Could not open the project from an older version again: ${errorText(e)}.`)
      }
    }
  }
  return { tabs: tabs.filter((t) => projects.has(t.id)), projects }
}

// --- Public API ----------------------------------------------------------------------------------

/** Opens tab `tab` from its IndexedDB record again. */
function restoreTab(tab: ProjectTab, record: StoredRecord | undefined) {
  if (!record) throw new Error('its recovery copy is missing')
  const stored = convertedRecord(record, tab)
  const project = checkedProject(stored.project)
  const location: ProjectLocation | undefined = stored.location ?? (stored.handle && { kind: 'local', handle: stored.handle })
  remember(tab.id, { project, savedContent: readSavedProject(stored.savedContent).content, location, driveRevision: stored.driveRevision }, false)
  // Until November 2026 every tab kept a name; a saved project's tab is called by its document.
  openTabs.push(location ? { id: tab.id } : tab)
}

/** How a restore error names tab `tab`: a saved project's tab no longer has a name of its own. */
const restoredTabLabel = (tab: ProjectTab) => (tab.name === undefined ? 'a saved project' : `"${tab.name}"`)

async function restoreSession(db: IDBDatabase) {
  const tabs = (await request(db.transaction(META_STORE).objectStore(META_STORE).get(TABS_RECORD))) as ProjectTab[] | undefined
  for (const tab of tabs ?? []) {
    try {
      restoreTab(tab, (await request(db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).get(tab.id))) as StoredRecord | undefined)
    } catch (e) {
      // A record that is there stays in IndexedDB as it is, but is not opened: the editor cannot draw it.
      restoreErrors.push(`Could not open ${restoredTabLabel(tab)} again: ${errorText(e)}.`)
    }
  }
  remove(META_STORE, OLD_RECENT_RECORD)
}

/** Loads the open projects into memory. Call once, before the editor starts. */
export async function openProjectStore() {
  try {
    db = await openDatabase()
  } catch {
    // No IndexedDB (private window, disabled): work from memory for this session.
  }
  if (db) {
    try {
      await restoreSession(db)
    } catch (e) {
      restoreErrors.push(`Could not reopen the tabs of the last session: ${errorText(e)}.`)
    }
  }
  if (openTabs.length === 0) {
    const legacy = readLegacyTabs()
    for (const tab of legacy.tabs) setSavedProject(tab.id, legacy.projects.get(tab.id)!)
    openTabs = legacy.tabs
    writeTabs(openTabs)
  }

  channel?.addEventListener('message', (e: MessageEvent<Message>) => {
    const message = e.data
    if (message.kind === 'tabs') {
      openTabs = message.tabs
      remoteListeners.forEach((listener) => listener(message))
    } else if (message.kind === 'removed') {
      openProjects.delete(message.id)
    } else {
      const checked = openProjects.get(message.id)?.checked ?? false
      remember(message.id, message.stored, checked)
      remoteListeners.forEach((listener) => listener({ kind: 'project', id: message.id, project: message.stored.project }))
    }
    notifyFiles()
  })
}

/** A new, unsaved project's name until it is saved. */
export const UNTITLED = 'Untitled'

/** The open tabs and the one this browser tab shows; a browser that has never been here gets the example. */
export function loadTabs(): { tabs: ProjectTab[]; activeId: string } {
  if (openTabs.length === 0) {
    const id = newTabId()
    const example = firstVisitExample()
    setSavedProject(id, example.open())
    openTabs = [{ id, name: example.name }]
    writeTabs(openTabs)
  }
  let remembered: string | null = null
  try {
    remembered = sessionStorage.getItem(ACTIVE_TAB_KEY)
  } catch {}
  const activeId = openTabs.some((t) => t.id === remembered) ? remembered! : openTabs[0].id
  return { tabs: openTabs, activeId }
}

function openProject(id: string): OpenProject {
  const open = openProjects.get(id)
  if (!open) throw new Error(`no open project has id "${id}"`)
  return open
}

export const readProject = (id: string): Project => openProject(id).project

export const projectFile = (id: string): ProjectFile => openProject(id)

/**
 * The name tab `tab` shows: its document's name (a file's on this computer, or a Drive document's as
 * last saved, opened or checked), or for a project saved nowhere the tab's own.
 */
export function nameOfTab(tab: ProjectTab): string {
  const { location, driveRevision } = openProject(tab.id)
  if (location?.kind === 'local') return projectNameOf(location.handle.name)
  if (location?.kind === 'drive') {
    if (!driveRevision) throw new Error(`tab "${tab.id}" has no name for its Google Drive document`)
    return driveRevision.name
  }
  if (tab.name === undefined) throw new Error(`tab "${tab.id}" has neither a document nor a name`)
  return tab.name
}

/**
 * Tab `id` now holds `project` as saved at `location`, or as a new project never saved: just opened,
 * or just saved. It has no unsaved changes. A document in Drive comes with its `driveRevision`.
 */
export function setSavedProject(id: string, project: Project, location?: ProjectLocation, driveRevision?: DriveRevision) {
  const content = projectToFile(project)
  openProjects.set(id, { project, content, savedContent: content, location, driveRevision, dirty: false, checked: true })
  persist(id)
  notifyFiles()
}

/** The recovery copy of a tab's project. */
export function writeProject(id: string, project: Project) {
  const open = openProject(id)
  const content = projectToFile(project)
  if (content === open.content) return
  const wasDirty = open.dirty
  Object.assign(open, { project, content, dirty: content !== open.savedContent })
  persist(id)
  if (open.dirty !== wasDirty) notifyFiles()
}

/**
 * The saved document holds `savedContent`, at `driveRevision` for a document in Drive; the tab keeps
 * its own project, which may now count as unsaved.
 */
export function acceptSavedContent(id: string, savedContent: string, driveRevision?: DriveRevision) {
  const open = openProjects.get(id)
  if (!open) return
  Object.assign(open, { savedContent, driveRevision, dirty: open.content !== savedContent, checked: true })
  persist(id)
  notifyFiles()
}

/** The document is gone or unreadable: the tab keeps its project, unsaved, and Save asks for a new location. */
export function unlinkLocation(id: string) {
  const open = openProjects.get(id)
  if (!open) return
  Object.assign(open, { location: undefined, driveRevision: undefined, savedContent: '', dirty: true, checked: true })
  persist(id)
  notifyFiles()
}

export function writeTabs(tabs: ProjectTab[]) {
  openTabs = tabs
  put(META_STORE, TABS_RECORD, tabs)
  tell({ kind: 'tabs', tabs })
}

export function removeProject(id: string) {
  openProjects.delete(id)
  remove(PROJECTS_STORE, id)
  tell({ kind: 'removed', id })
}

async function isSameLocation(a: ProjectLocation, b: ProjectLocation): Promise<boolean> {
  if (a.kind === 'drive') return b.kind === 'drive' && a.fileId === b.fileId
  if (b.kind === 'drive') return false
  return a.handle.isSameEntry(b.handle)
}

/** The open tab showing the document at `location`, if any. */
export async function tabShowing(location: ProjectLocation): Promise<string | undefined> {
  for (const tab of openTabs) {
    const open = openProjects.get(tab.id)?.location
    if (open && (await isSameLocation(open, location))) return tab.id
  }
  return undefined
}

export function rememberActiveTab(id: string) {
  try {
    sessionStorage.setItem(ACTIVE_TAB_KEY, id)
  } catch {}
}

/**
 * Counts the changes to the tabs' file status (saved, unsaved, checked), so React can tell that
 * projectFile may give something new: the snapshot for useSyncExternalStore with onFileChange.
 */
export const fileStatusVersion = () => fileStatusChanges

/** Called when a tab's file status changes (saved, unsaved, checked). Returns the unsubscribe. */
export function onFileChange(listener: () => void) {
  fileListeners.add(listener)
  return () => void fileListeners.delete(listener)
}

/** Called when another browser tab changes the tabs or a project. Returns the unsubscribe. */
export function onRemoteChange(listener: (change: RemoteChange) => void) {
  remoteListeners.add(listener)
  return () => void remoteListeners.delete(listener)
}
