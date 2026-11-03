// The open projects (one per tab) live in IndexedDB as recovery copies: every change lands there,
// so a crash or reload loses nothing. The project file on disk only changes on an explicit save.
// Each record keeps the file content as last saved or opened, which tells whether the tab has
// unsaved changes and whether the file changed on disk since.
//
// The editor reads and writes a copy in memory, loaded once before it starts; IndexedDB is written
// behind it. Other browser tabs hear about changes over a BroadcastChannel. Each browser tab
// remembers its own active project in sessionStorage, so two browser tabs can work on different
// projects without overwriting each other.
//
// Drive sync (driveSync.ts) follows every change through onStoreChange, and brings in changes from
// other computers as if another browser tab made them.

import { checkedDefinitions, withDefinitions } from './definitions'
import { errorText } from './errorText'
import { withoutCutLines } from './migrateCutLayout'
import { migrateGappedIslands } from './migrateIslands'
import { STRATEGIES } from './optimize'
import type { Project, Settings } from './types'

export interface ProjectTab {
  id: string
  name: string
}

/** Where a tab's project stands against its file. */
export interface ProjectFile {
  /** The linked file; none for a project that was never saved (or saved by download). */
  handle?: FileSystemFileHandle
  /** File content as last saved or opened. */
  savedContent: string
  /** The project differs from `savedContent`. */
  dirty: boolean
  /** The file on disk was compared with `savedContent` in this session. Always true without a file. */
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
const ACTIVE_TAB_KEY = 'manhattan-layout-editor/active-tab'

/** Why tabs from the last session could not be opened again; the editor shows them once it is up. */
export const restoreErrors: string[] = []

const openProjects = new Map<string, OpenProject>()
let openTabs: ProjectTab[] = []
let db: IDBDatabase | null = null
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DB_NAME)
const fileListeners = new Set<() => void>()
const storeListeners = new Set<() => void>()
const remoteListeners = new Set<(change: RemoteChange) => void>()

export const emptyProject = (settings: Settings = DEFAULT_SETTINGS): Project => ({
  guid: crypto.randomUUID(),
  name: 'Untitled',
  netlist: { components: [], nets: [] },
  layout: { islands: [], placements: [] },
  settings,
})

export const newTabId = () => Math.random().toString(36).slice(2, 10)

/**
 * A project read from storage or a file; projects from before guids get one here, parts without a
 * component definition get one from the built-in templates, and a cut-line layout becomes islands.
 * Null without a netlist or layout; an invalid component definition throws, naming it.
 */
function checkedProject(data: unknown): Project | null {
  const project = data as Partial<Project> | null
  if (!project?.netlist?.components || !project.layout?.islands) return null
  return withoutCutLines(
    withDefinitions({
      ...(project as Project),
      guid: project.guid || crypto.randomUUID(),
      definitions: checkedDefinitions(project.definitions),
      settings: { ...DEFAULT_SETTINGS, ...project.settings },
    }),
  )
}

// A saved project file. Bump the version when the stored layout changes meaning, and convert
// older files in projectFromFile.
// v6: component definitions (symbol and footprints) are stored in the project.
const FILE_FORMAT = 'manhattan-layout-editor'
const FILE_VERSION = 6

export function projectToFile(project: Project): string {
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, project: withDefinitions(project) }, null, 2)
}

export function projectFromFile(text: string): Project {
  const data = JSON.parse(text) as { format?: unknown; version?: unknown; project?: unknown }
  if (data?.format !== FILE_FORMAT || typeof data.version !== 'number') throw new Error('Not a Manhattan project file.')
  if (data.version > FILE_VERSION) throw new Error('This project was saved by a newer version of the editor.')
  const project = checkedProject(data.project)
  if (!project) throw new Error('The project file is damaged: netlist or layout is missing.')
  return project
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

const storedOf = (open: OpenProject): StoredProject => ({ project: open.project, savedContent: open.savedContent, handle: open.handle })

function persist(id: string) {
  const open = openProjects.get(id)
  if (!open) return
  const stored = storedOf(open)
  put(PROJECTS_STORE, id, stored)
  tell({ kind: 'project', id, stored })
  notifyStore()
}

function remember(id: string, stored: StoredProject, checked: boolean) {
  const content = projectToFile(stored.project)
  openProjects.set(id, {
    ...stored,
    content,
    dirty: content !== stored.savedContent,
    checked: checked || !stored.handle,
  })
}

const notifyFiles = () => fileListeners.forEach((listener) => listener())
const notifyStore = () => storeListeners.forEach((listener) => listener())

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

/**
 * The tabs and projects from before IndexedDB, or from before tabs (a single v3 project under the
 * bare prefix). localStorage is left as it is, as a way back.
 */
function readLegacyTabs(): { tabs: ProjectTab[]; projects: Map<string, Project> } {
  const listed = readLegacyJson(LEGACY_TABS_KEY)
  const tabs = Array.isArray(listed) ? (listed as ProjectTab[]).filter((t) => typeof t?.id === 'string') : []
  const projects = new Map<string, Project>()
  for (const tab of tabs) {
    const current = checkedProject(readLegacyJson(`${LEGACY_PROJECT_PREFIX}/${tab.id}`))
    const v3 = current ? null : checkedProject(readLegacyJson(`${V3_PROJECT_PREFIX}/${tab.id}`))
    const project = current ?? (v3 ? migrateGappedIslands(v3) : null)
    if (project) projects.set(tab.id, project)
  }
  if (tabs.length === 0) {
    const single = checkedProject(readLegacyJson(V3_PROJECT_PREFIX))
    if (single) {
      const id = newTabId()
      tabs.push({ id, name: single.name })
      projects.set(id, migrateGappedIslands(single))
    }
  }
  return { tabs: tabs.filter((t) => projects.has(t.id)), projects }
}

// --- Public API ----------------------------------------------------------------------------------

/** Loads the open projects into memory. Call once, before the editor starts. */
export async function openProjectStore() {
  try {
    db = await openDatabase()
    const transaction = db.transaction([PROJECTS_STORE, META_STORE])
    const tabs = (await request(transaction.objectStore(META_STORE).get(TABS_RECORD))) as ProjectTab[] | undefined
    for (const tab of tabs ?? []) {
      const stored = (await request(db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).get(tab.id))) as StoredProject | undefined
      if (!stored) continue
      let project: Project | null
      try {
        project = checkedProject(stored.project)
      } catch (e) {
        // Left in IndexedDB as it is, but not opened: the editor cannot draw it.
        restoreErrors.push(`Could not open "${tab.name}" again: ${errorText(e)}.`)
        continue
      }
      if (!project) continue
      remember(tab.id, { ...stored, project }, false)
      openTabs.push(tab)
    }
  } catch {
    // No IndexedDB (private window, disabled): work from memory for this session.
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
    notifyStore()
  })
}

// Every project file in src/examples is offered under File > Examples.
const EXAMPLE_FILES = import.meta.glob<string>('./examples/*.manhattan.json', { query: '?raw', import: 'default', eager: true })
const FIRST_VISIT_EXAMPLE = './examples/multivibrator.manhattan.json'

export interface Example {
  name: string
  /** A fresh copy: each is a project of its own, so it gets its own guid. */
  open: () => Project
}

const exampleFrom = (text: string): Example => ({
  name: projectFromFile(text).name,
  open: () => ({ ...projectFromFile(text), guid: crypto.randomUUID() }),
})

export const EXAMPLES: Example[] = Object.values(EXAMPLE_FILES)
  .map(exampleFrom)
  .sort((a, b) => a.name.localeCompare(b.name))

/** The open tabs and the one this browser tab shows; a browser that has never been here gets the example. */
export function loadTabs(): { tabs: ProjectTab[]; activeId: string } {
  if (openTabs.length === 0) {
    const id = newTabId()
    const project = exampleFrom(EXAMPLE_FILES[FIRST_VISIT_EXAMPLE]).open()
    addProject(id, project)
    openTabs = [{ id, name: project.name }]
    writeTabs(openTabs)
  }
  let remembered: string | null = null
  try {
    remembered = sessionStorage.getItem(ACTIVE_TAB_KEY)
  } catch {}
  const activeId = openTabs.some((t) => t.id === remembered) ? remembered! : openTabs[0].id
  return { tabs: openTabs, activeId }
}

export function readProject(id: string): Project {
  return openProjects.get(id)?.project ?? emptyProject()
}

export function projectFile(id: string): ProjectFile {
  return openProjects.get(id) ?? { savedContent: '', dirty: false, checked: true }
}

/** A project that just opened in a tab, from `handle` or new; it starts without unsaved changes. */
export function addProject(id: string, project: Project, handle?: FileSystemFileHandle) {
  const content = projectToFile(project)
  openProjects.set(id, { project, content, savedContent: content, handle, dirty: false, checked: true })
  persist(id)
  notifyFiles()
}

/** The recovery copy of a tab's project. */
export function writeProject(id: string, project: Project) {
  const open = openProjects.get(id)
  const content = projectToFile(project)
  if (!open) return addProject(id, project)
  if (content === open.content) return
  const wasDirty = open.dirty
  Object.assign(open, { project, content, dirty: content !== open.savedContent })
  persist(id)
  if (open.dirty !== wasDirty) notifyFiles()
}

/** `project` is now in its file, as `handle`. */
export function markSaved(id: string, project: Project, handle?: FileSystemFileHandle) {
  const content = projectToFile(project)
  openProjects.set(id, { project, content, savedContent: content, handle, dirty: false, checked: true })
  persist(id)
  notifyFiles()
}

/** The file holds `fileContent`; the tab keeps its own project, which may now count as unsaved. */
export function acceptFileContent(id: string, fileContent: string) {
  const open = openProjects.get(id)
  if (!open) return
  Object.assign(open, { savedContent: fileContent, dirty: open.content !== fileContent, checked: true })
  persist(id)
  notifyFiles()
}

/** The file is gone or unreadable: the tab keeps its project, unsaved, and Save asks for a new file. */
export function unlinkFile(id: string) {
  const open = openProjects.get(id)
  if (!open) return
  Object.assign(open, { handle: undefined, savedContent: '', dirty: true, checked: true })
  persist(id)
  notifyFiles()
}

export function writeTabs(tabs: ProjectTab[]) {
  openTabs = tabs
  put(META_STORE, TABS_RECORD, tabs)
  tell({ kind: 'tabs', tabs })
  notifyStore()
}

export function removeProject(id: string) {
  openProjects.delete(id)
  remove(PROJECTS_STORE, id)
  tell({ kind: 'removed', id })
  notifyStore()
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

/** Called after any change to the tabs or a project, from this browser tab or another. Returns the unsubscribe. */
export function onStoreChange(listener: () => void) {
  storeListeners.add(listener)
  return () => void storeListeners.delete(listener)
}

// --- Drive sync ----------------------------------------------------------------------------------

export const currentTabs = () => openTabs

/** Tab `id`'s project as file content; undefined for a tab this browser does not have. */
export const projectContent = (id: string): string | undefined => openProjects.get(id)?.content

/**
 * Tab `id`'s project as another device left it, shown as if another browser tab changed it. A file
 * link stays: it belongs to this device, and so does what was last saved to that file.
 */
export function applySyncedProject(id: string, project: Project) {
  const open = openProjects.get(id)
  remember(id, { project, savedContent: open?.savedContent ?? projectToFile(project), handle: open?.handle }, open?.checked ?? true)
  persist(id)
  remoteListeners.forEach((listener) => listener({ kind: 'project', id, project }))
  notifyFiles()
}

/** The tabs as another device left them; projects of tabs that are gone are dropped. */
export function applySyncedTabs(tabs: ProjectTab[]) {
  for (const tab of openTabs) if (!tabs.some((t) => t.id === tab.id)) removeProject(tab.id)
  writeTabs(tabs)
  remoteListeners.forEach((listener) => listener({ kind: 'tabs', tabs }))
}
