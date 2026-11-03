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

import { checkedDefinitions, withDefinitions, withoutUnfitDefinitions } from './definitions'
import { errorText } from './errorText'
import { withoutCutLines } from './migrateCutLayout'
import { migrateGappedIslands } from './migrateIslands'
import { findStrategy, STRATEGIES } from './optimize'
import type { Project, Settings } from './types'

export interface ProjectTab {
  id: string
  name: string
}

/**
 * Where a project is saved: a file on this computer, or a document in the editor's folder in
 * Google Drive. `version` is Drive's version of the document as last saved or opened here.
 */
export type ProjectLocation = { kind: 'local'; handle: FileSystemFileHandle } | { kind: 'drive'; fileId: string; version: string }

/** Where a tab's project stands against its saved document. */
export interface ProjectFile {
  /** None for a project that was never saved (or saved by download). */
  location?: ProjectLocation
  /** Document content as last saved or opened. */
  savedContent: string
  /** The project differs from `savedContent`. */
  dirty: boolean
  /** The saved document was compared with `savedContent` in this session. Always true without a location. */
  checked: boolean
}

/** A document opened or saved lately, for the Open recent menu. */
export interface RecentDocument {
  name: string
  location: ProjectLocation
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
  /** Before locations: the linked file. */
  handle?: FileSystemFileHandle
}

type Message = { kind: 'tabs'; tabs: ProjectTab[] } | { kind: 'project'; id: string; stored: StoredProject } | { kind: 'removed'; id: string }

/** Something changed in another browser tab. */
export type RemoteChange = { kind: 'tabs'; tabs: ProjectTab[] } | { kind: 'project'; id: string; project: Project }

export const DEFAULT_SETTINGS: Settings = { snap: 0.5, isolation: 0.4, strategy: STRATEGIES[0].id, clearance: 3, maxLead: 10 }

const DB_NAME = 'manhattan-layout-editor'
const PROJECTS_STORE = 'projects'
const META_STORE = 'meta'
const TABS_RECORD = 'tabs'
const RECENT_RECORD = 'recent'
const MAX_RECENT = 8
const ACTIVE_TAB_KEY = 'manhattan-layout-editor/active-tab'

/** Why tabs from the last session could not be opened again; the editor shows them once it is up. */
export const restoreErrors: string[] = []

const openProjects = new Map<string, OpenProject>()
let openTabs: ProjectTab[] = []
let recent: RecentDocument[] = []
let db: IDBDatabase | null = null
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DB_NAME)
const fileListeners = new Set<() => void>()
const remoteListeners = new Set<(change: RemoteChange) => void>()

export const emptyProject = (settings: Settings = DEFAULT_SETTINGS): Project => ({
  guid: crypto.randomUUID(),
  netlist: { components: [], nets: [] },
  layout: { islands: [], placements: [] },
  settings,
})

export const newTabId = () => Math.random().toString(36).slice(2, 10)

/**
 * A project read from storage or a file; projects from before guids get one here, parts without a
 * component definition get one from the built-in templates, and a cut-line layout becomes islands.
 * The name older versions stored is dropped. Throws without a netlist or layout, and for an invalid
 * component definition, naming it.
 */
function checkedProject(data: unknown): Project {
  const project = { ...(data as Partial<Project> & { name?: unknown }) }
  if (!project?.netlist?.components || !project.layout?.islands) throw new Error('the project is damaged: netlist or layout is missing')
  delete project.name
  const definitions = checkedDefinitions(project.definitions)
  const checked = withoutCutLines(
    withDefinitions({
      ...(project as Project),
      guid: project.guid || crypto.randomUUID(),
      // Recovery copies from before definitions were checked may still refer to one a re-import made unfit.
      netlist: withoutUnfitDefinitions(project.netlist, definitions),
      definitions,
      settings: { ...DEFAULT_SETTINGS, ...project.settings },
    }),
  )
  return { ...checked, settings: { ...checked.settings, strategy: findStrategy(checked.settings.strategy).id } }
}

// A saved project file. Bump the version when the stored layout changes meaning, and convert
// older files in projectFromFile.
// v6: component definitions (symbol and footprints) are stored in the project.
// v7: no name inside: a project is called by its file's name.
const FILE_FORMAT = 'manhattan-layout-editor'
const FILE_VERSION = 7

export function projectToFile(project: Project): string {
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, project: withDefinitions(project) }, null, 2)
}

/**
 * `text` as this version of the editor writes it, so saved contents compare equal whatever version
 * wrote them; text that is no project stays as it is.
 */
export function asCurrentFormat(text: string): string {
  try {
    return projectToFile(projectFromFile(text))
  } catch {
    return text
  }
}

/** "amp.manhattan.json" → "amp". */
export const projectNameOf = (fileName: string) => fileName.replace(/(\.manhattan)?\.json$/i, '')

export function projectFromFile(text: string): Project {
  const data = JSON.parse(text) as { format?: unknown; version?: unknown; project?: unknown }
  if (data?.format !== FILE_FORMAT || typeof data.version !== 'number') throw new Error('Not a Manhattan project file.')
  if (data.version > FILE_VERSION) throw new Error('This project was saved by a newer version of the editor.')
  return checkedProject(data.project)
}

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

const storedOf = (open: OpenProject): StoredProject => ({ project: open.project, savedContent: open.savedContent, location: open.location })

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

const notifyFiles = () => fileListeners.forEach((listener) => listener())

// --- Before IndexedDB: localStorage --------------------------------------------------------------

// v5: islands touch; the isolation cut runs along their shared edges (see migrateIslands.ts).
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
function restoreTab(tab: ProjectTab, stored: StoredProject | undefined) {
  if (!stored) throw new Error('its recovery copy is missing')
  const project = checkedProject(stored.project)
  const location: ProjectLocation | undefined = stored.location ?? (stored.handle && { kind: 'local', handle: stored.handle })
  remember(tab.id, { project, savedContent: asCurrentFormat(stored.savedContent), location }, false)
  // Tabs from when projects held a name of their own may still show it instead of their file's.
  openTabs.push(location?.kind === 'local' ? { ...tab, name: projectNameOf(location.handle.name) } : tab)
}

async function restoreSession(db: IDBDatabase) {
  const tabs = (await request(db.transaction(META_STORE).objectStore(META_STORE).get(TABS_RECORD))) as ProjectTab[] | undefined
  for (const tab of tabs ?? []) {
    try {
      restoreTab(tab, (await request(db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).get(tab.id))) as StoredProject | undefined)
    } catch (e) {
      // A record that is there stays in IndexedDB as it is, but is not opened: the editor cannot draw it.
      restoreErrors.push(`Could not open "${tab.name}" again: ${errorText(e)}.`)
    }
  }
  recent = ((await request(db.transaction(META_STORE).objectStore(META_STORE).get(RECENT_RECORD))) as RecentDocument[] | undefined) ?? []
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
    for (const tab of legacy.tabs) addProject(tab.id, legacy.projects.get(tab.id)!)
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

// Every project file in src/examples is offered under File > Examples, called by its file name.
const EXAMPLE_FILES = import.meta.glob<string>('./examples/*.manhattan.json', { query: '?raw', import: 'default', eager: true })
const FIRST_VISIT_EXAMPLE = './examples/Astable multivibrator.manhattan.json'

export interface Example {
  name: string
  /** A fresh copy: each is a project of its own, so it gets its own guid. */
  open: () => Project
}

const exampleFrom = (path: string, text: string): Example => ({
  name: path.replace(/^.*\//, '').replace(/\.manhattan\.json$/, ''),
  open: () => ({ ...projectFromFile(text), guid: crypto.randomUUID() }),
})

export const EXAMPLES: Example[] = Object.entries(EXAMPLE_FILES)
  .map(([path, text]) => exampleFrom(path, text))
  .sort((a, b) => a.name.localeCompare(b.name))

/** A new, unsaved project's name until it is saved. */
export const UNTITLED = 'Untitled'

/** The open tabs and the one this browser tab shows; a browser that has never been here gets the example. */
export function loadTabs(): { tabs: ProjectTab[]; activeId: string } {
  if (openTabs.length === 0) {
    const id = newTabId()
    const example = exampleFrom(FIRST_VISIT_EXAMPLE, EXAMPLE_FILES[FIRST_VISIT_EXAMPLE])
    addProject(id, example.open())
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

/** A project that just opened in a tab, from `location` or new; it starts without unsaved changes. */
export function addProject(id: string, project: Project, location?: ProjectLocation) {
  const content = projectToFile(project)
  openProjects.set(id, { project, content, savedContent: content, location, dirty: false, checked: true })
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

/** `project` is now saved at `location`. */
export function markSaved(id: string, project: Project, location?: ProjectLocation) {
  const content = projectToFile(project)
  openProjects.set(id, { project, content, savedContent: content, location, dirty: false, checked: true })
  persist(id)
  notifyFiles()
}

/**
 * The saved document, now at `location`, holds `savedContent`; the tab keeps its own project, which
 * may now count as unsaved.
 */
export function acceptSavedContent(id: string, savedContent: string, location: ProjectLocation) {
  const open = openProjects.get(id)
  if (!open) return
  Object.assign(open, { savedContent, location, dirty: open.content !== savedContent, checked: true })
  persist(id)
  notifyFiles()
}

/** The document is gone or unreadable: the tab keeps its project, unsaved, and Save asks for a new location. */
export function unlinkLocation(id: string) {
  const open = openProjects.get(id)
  if (!open) return
  Object.assign(open, { location: undefined, savedContent: '', dirty: true, checked: true })
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

export const recentDocuments = () => recent

async function isSameLocation(a: ProjectLocation, b: ProjectLocation): Promise<boolean> {
  if (a.kind === 'drive') return b.kind === 'drive' && a.fileId === b.fileId
  if (b.kind === 'drive') return false
  return a.handle.isSameEntry(b.handle)
}

/** Puts the document at `location` first in the recent documents. */
export async function rememberRecent(name: string, location: ProjectLocation) {
  const others: RecentDocument[] = []
  for (const document of recent) if (!(await isSameLocation(document.location, location))) others.push(document)
  recent = [{ name, location }, ...others].slice(0, MAX_RECENT)
  put(META_STORE, RECENT_RECORD, recent)
}

/** Takes a document off the recent list, for one that cannot be opened anymore. */
export async function forgetRecent(location: ProjectLocation) {
  const kept: RecentDocument[] = []
  for (const document of recent) if (!(await isSameLocation(document.location, location))) kept.push(document)
  recent = kept
  put(META_STORE, RECENT_RECORD, recent)
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
