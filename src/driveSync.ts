// Keeps the open tabs and their projects in the user's Google Drive, so signing in on another
// computer brings the same workspace back. Drive's app data folder holds a workspace file with the
// tab list and a project file per tab. The browser's own storage stays the working copy: the editor
// never waits for Drive, and works on without it.
//
// A sync compares what Drive has, what this device has, and what both had at the last sync (kept
// per device). A change on one side is copied to the other. A project changed on both sides keeps
// this device's version, and Drive's version opens in a new tab, so nothing is lost.
//
// One browser tab does the syncing (a Web Lock picks it); the project store keeps it up to date
// with changes from the other browser tabs.

import { errorText } from './errorText'
import { googleAppFolder, accessToken, driveConfigured, signIn, signOut, SignInNeeded, TOKEN_KEY, type AppFolder } from './googleDrive'
import {
  applySyncedProject,
  applySyncedTabs,
  currentTabs,
  newTabId,
  onStoreChange,
  projectContent,
  projectFromFile,
  type ProjectTab,
} from './projectStore'
import type { Project } from './types'

export { driveConfigured }

const WORKSPACE_FILE = 'workspace.json'
const tabFileName = (id: string) => `tab-${id}.manhattan.json`

/** What this device and Drive both had at the last sync. */
export interface SyncState {
  /** Drive's version of the workspace file; none before the first sync. */
  workspaceVersion?: string
  tabs: ProjectTab[]
  /** Per tab: Drive's version of its file, and a hash of the project content in it. */
  files: Record<string, { version: string; hash: string }>
}

export const NEVER_SYNCED: SyncState = { tabs: [], files: {} }

/** The workspace on this device, as the sync reads and changes it. */
export interface Workspace {
  tabs(): ProjectTab[]
  /** The tab's project as file content; undefined for a tab this device does not have. */
  content(id: string): string | undefined
  applyProject(id: string, project: Project): void
  applyTabs(tabs: ProjectTab[]): void
  newTabId(): string
}

async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseWorkspace(text: string): ProjectTab[] {
  const tabs = (JSON.parse(text) as { tabs?: unknown }).tabs
  if (!Array.isArray(tabs) || !tabs.every((t) => typeof t?.id === 'string' && typeof t?.name === 'string')) {
    throw new Error(`the ${WORKSPACE_FILE} in Google Drive is damaged`)
  }
  return tabs as ProjectTab[]
}

/**
 * The tab list after a sync: Drive's order without the tabs closed here, then the tabs opened here.
 * A tab closed elsewhere stays when it has changes here that Drive does not have. A tab keeps its
 * name from here, which follows its project.
 */
export function mergeTabs(drive: ProjectTab[], here: ProjectTab[], synced: ProjectTab[], changedHere: (id: string) => boolean): ProjectTab[] {
  const hereById = new Map(here.map((t) => [t.id, t]))
  const wasSynced = new Set(synced.map((t) => t.id))
  const inDrive = new Set(drive.map((t) => t.id))
  const kept = drive.filter((t) => hereById.has(t.id) || !wasSynced.has(t.id)).map((t) => hereById.get(t.id) ?? t)
  const opened = here.filter((t) => !inDrive.has(t.id) && (!wasSynced.has(t.id) || changedHere(t.id)))
  return [...kept, ...opened]
}

/** One sync of `workspace` with `folder`. Returns the state to keep for the next sync, and the names of projects changed on both sides. */
export async function syncWorkspace(folder: AppFolder, workspace: Workspace, previous: SyncState): Promise<{ state: SyncState; conflicts: string[] }> {
  const driveFiles = new Map((await folder.list()).map((file) => [file.name, file]))
  const workspaceFile = driveFiles.get(WORKSPACE_FILE)
  // Without a workspace file Drive was emptied (or never used): start over, so nothing here counts as closed elsewhere.
  const synced = workspaceFile ? previous : NEVER_SYNCED

  const hereTabs = workspace.tabs()
  const changedHere = new Set<string>()
  for (const tab of hereTabs) {
    const content = workspace.content(tab.id)
    if (content !== undefined && (await hashOf(content)) !== synced.files[tab.id]?.hash) changedHere.add(tab.id)
  }

  let driveTabs: ProjectTab[] = []
  if (workspaceFile) driveTabs = workspaceFile.version === synced.workspaceVersion ? synced.tabs : parseWorkspace(await folder.read(workspaceFile.id))

  const merged = mergeTabs(driveTabs, hereTabs, synced.tabs, (id) => changedHere.has(id))
  const tabs = merged.length > 0 ? merged : hereTabs
  const files: SyncState['files'] = {}
  const conflicts: string[] = []
  const missing = new Set<string>()

  // Copies of conflicting projects are added to `tabs` on the way, and synced in the same loop.
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]
    const file = driveFiles.get(tabFileName(tab.id))
    const known = synced.files[tab.id]
    if (file && (file.version !== known?.version || workspace.content(tab.id) === undefined)) {
      const fromDrive = projectFromFile(await folder.read(file.id))
      if (changedHere.has(tab.id)) {
        const copyId = workspace.newTabId()
        workspace.applyProject(copyId, fromDrive)
        tabs.push({ id: copyId, name: `${fromDrive.name} (other computer)` })
        conflicts.push(tab.name)
      } else {
        workspace.applyProject(tab.id, fromDrive)
        files[tab.id] = { version: file.version, hash: await hashOf(workspace.content(tab.id)!) }
        continue
      }
    }
    const content = workspace.content(tab.id)
    if (content === undefined) {
      // Listed in the workspace file, but its own file is gone.
      missing.add(tab.id)
    } else if (file && known && !changedHere.has(tab.id) && file.version === known.version) {
      files[tab.id] = known
    } else {
      const written = await folder.write(tabFileName(tab.id), content, file?.id)
      files[tab.id] = { version: written.version, hash: await hashOf(content) }
    }
  }

  const finalTabs = tabs.filter((t) => !missing.has(t.id))
  if (JSON.stringify(finalTabs) !== JSON.stringify(hereTabs)) workspace.applyTabs(finalTabs)

  // Tab files are written before the workspace file lists them. Another device syncing in between
  // sees files of tabs it never knew, and leaves them alone: only tabs this device synced are removed.
  for (const id of Object.keys(synced.files)) {
    const file = driveFiles.get(tabFileName(id))
    if (file && !files[id]) await folder.remove(file.id)
  }

  let workspaceVersion = workspaceFile?.version
  if (!workspaceFile || JSON.stringify(finalTabs) !== JSON.stringify(driveTabs)) {
    workspaceVersion = (await folder.write(WORKSPACE_FILE, JSON.stringify({ tabs: finalTabs }), workspaceFile?.id)).version
  }
  return { state: { workspaceVersion, tabs: finalTabs, files }, conflicts }
}

// --- In the editor -------------------------------------------------------------------------------

/** Per device; there is one only while sync is on. */
const STATE_KEY = 'manhattan-layout-editor/drive-sync'
const LOCK_NAME = 'manhattan-layout-editor/drive-sync'
const SYNC_AFTER_CHANGE_MS = 2000
const SYNC_EVERY_MS = 30_000

/** Sync off; on and signed in; or on but waiting for the user to sign in again. */
export type DriveStatus = 'off' | 'on' | 'signed-out'

function readState(): SyncState | null {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as SyncState | null
  } catch {
    return null
  }
}

function writeState(state: SyncState | null) {
  try {
    if (state) localStorage.setItem(STATE_KEY, JSON.stringify(state))
    else localStorage.removeItem(STATE_KEY)
  } catch {}
}

export function driveStatus(): DriveStatus {
  if (!readState()) return 'off'
  return accessToken() ? 'on' : 'signed-out'
}

const storeWorkspace: Workspace = {
  tabs: currentTabs,
  content: projectContent,
  applyProject: applySyncedProject,
  applyTabs: applySyncedTabs,
  newTabId,
}

const statusListeners = new Set<() => void>()
const notifyStatus = () => statusListeners.forEach((listener) => listener())

/** Called when the status may have changed. Returns the unsubscribe. */
export function onDriveStatus(listener: () => void) {
  statusListeners.add(listener)
  return () => void statusListeners.delete(listener)
}

interface Reporter {
  error(text: string): void
  notice(text: string): void
}

let reporter: Reporter = { error: () => {}, notice: () => {} }
/** This browser tab holds the lock and does the syncing. */
let isSyncer = false
let syncing = false
let syncAgain = false
let syncTimer: ReturnType<typeof setTimeout> | undefined
/** The last error shown, so a sync that keeps failing does not show it every time. */
let lastError = ''

function requestSync(delay: number) {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(runSync, delay)
}

async function runSync() {
  const state = readState()
  if (!isSyncer || !state || !accessToken()) return
  if (syncing) {
    syncAgain = true
    return
  }
  syncing = true
  try {
    const result = await syncWorkspace(googleAppFolder, storeWorkspace, state)
    // Sync may have been turned off meanwhile.
    if (readState()) writeState(result.state)
    lastError = ''
    if (result.conflicts.length > 0) {
      reporter.notice(`Changed here and on another computer: ${result.conflicts.join(', ')}. The other version opened in a new tab.`)
    }
  } catch (e) {
    if (e instanceof SignInNeeded) {
      notifyStatus()
    } else {
      const text = `Google Drive sync failed: ${errorText(e)}`
      if (text !== lastError) reporter.error(text)
      lastError = text
    }
  } finally {
    syncing = false
    if (syncAgain) {
      syncAgain = false
      requestSync(0)
    }
  }
}

let started = false

/** Starts syncing when sync is on; call once, when the editor is up. */
export function startDriveSync(report: Reporter) {
  reporter = report
  if (started || !driveConfigured) return
  started = true
  const becomeSyncer = () => {
    isSyncer = true
    onStoreChange(() => requestSync(SYNC_AFTER_CHANGE_MS))
    window.addEventListener('focus', () => requestSync(0))
    setInterval(() => {
      if (document.visibilityState === 'visible') requestSync(0)
    }, SYNC_EVERY_MS)
    window.addEventListener('storage', (e) => {
      if (e.key === TOKEN_KEY || e.key === STATE_KEY) requestSync(0)
    })
    requestSync(0)
  }
  // Held for as long as this browser tab is open; the next one takes over when it closes.
  if (navigator.locks) navigator.locks.request(LOCK_NAME, () => new Promise<void>(() => becomeSyncer()))
  else becomeSyncer()
  // Every browser tab shows the status: sign-in runs out, or another tab signs in or out.
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY || e.key === STATE_KEY) notifyStatus()
  })
  setInterval(notifyStatus, SYNC_EVERY_MS)
}

/** Signs in and turns sync on. Call it from a click: it opens Google's sign-in window. */
export async function connectDrive() {
  await signIn()
  if (!readState()) writeState(NEVER_SYNCED)
  notifyStatus()
  requestSync(0)
}

/** Turns sync off on this device. The workspace here stays as it is, and so does Drive's copy. */
export function disconnectDrive() {
  writeState(null)
  signOut()
  notifyStatus()
}
