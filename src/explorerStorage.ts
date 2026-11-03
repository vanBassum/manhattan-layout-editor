// What the file explorer browses: the work folders the user added, on this computer or in Google
// Drive, and their subfolders. Both kinds of folder go through the same functions.

import { createFolder, isFolder, listFolder, renameItem, trashItem, writeFile } from './googleDrive'
import type { FolderRef, ProjectLocation } from './projectStore'

export type { FolderRef }

/** A folder or project file in a folder. */
export interface ExplorerEntry {
  /** As shown: a project file without its extension. */
  name: string
  /** As stored. */
  fileName: string
  modified?: number
  size?: number
  /** Set for folders. */
  folder?: FolderRef
  /** Set for project files. */
  location?: ProjectLocation
}

const PROJECT_EXTENSION = '.manhattan.json'
const isProjectFile = (fileName: string) => /\.json$/i.test(fileName)
/** "amp.manhattan.json" → "amp". */
export const projectName = (fileName: string) => fileName.replace(/(\.manhattan)?\.json$/i, '')
const fileNameOf = (name: string) => `${name}${PROJECT_EXTENSION}`

// The folder picker for work folders: Chromium browsers only.
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }
  interface FileSystemHandle {
    /** Renames in place; not in every browser. */
    move?: (name: string) => Promise<void>
  }
}

export const canUseFolders = typeof globalThis.window?.showDirectoryPicker === 'function'

/** A folder the user picks on this computer, or null when cancelled. */
export async function pickWorkFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker!({ id: 'manhattan-work-folder', mode: 'readwrite' })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null
    throw e
  }
}

/** Whether the editor may use the work folder; after a reload the browser asks again, only from a click (`ask`). */
export async function mayUseFolder(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return ask && (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
}

const byFolderThenName = (a: ExplorerEntry, b: ExplorerEntry) => Number(!a.folder) - Number(!b.folder) || a.name.localeCompare(b.name)

export async function listEntries(folder: FolderRef): Promise<ExplorerEntry[]> {
  const entries: ExplorerEntry[] = []
  if (folder.kind === 'drive') {
    for (const item of await listFolder(folder.id)) {
      const modified = Date.parse(item.modifiedTime)
      if (isFolder(item)) entries.push({ name: item.name, fileName: item.name, modified, folder: { kind: 'drive', id: item.id } })
      else if (isProjectFile(item.name)) {
        const location: ProjectLocation = { kind: 'drive', fileId: item.id, version: item.version }
        entries.push({ name: projectName(item.name), fileName: item.name, modified, size: Number(item.size), location })
      }
    }
  } else {
    for await (const handle of folder.handle.values()) {
      if (handle.kind === 'directory') entries.push({ name: handle.name, fileName: handle.name, folder: { kind: 'local', handle } })
      else if (isProjectFile(handle.name)) {
        const file = await handle.getFile()
        const location: ProjectLocation = { kind: 'local', handle }
        entries.push({ name: projectName(handle.name), fileName: handle.name, modified: file.lastModified, size: file.size, location })
      }
    }
  }
  return entries.sort(byFolderThenName)
}

/** The entry in `entries` that a new folder or project `name` would collide with. */
export function entryNamed(entries: ExplorerEntry[], name: string, isFolder: boolean): ExplorerEntry | undefined {
  const wanted = (isFolder ? name : fileNameOf(name)).toLowerCase()
  return entries.find((entry) => entry.fileName.toLowerCase() === wanted || (!isFolder && !entry.folder && entry.name.toLowerCase() === name.toLowerCase()))
}

export async function makeFolder(parent: FolderRef, name: string) {
  if (parent.kind === 'drive') await createFolder(parent.id, name)
  else await parent.handle.getDirectoryHandle(name, { create: true })
}

/** The Drive id of an entry in a Drive folder. */
function driveIdOf(entry: ExplorerEntry): string {
  if (entry.folder?.kind === 'drive') return entry.folder.id
  if (entry.location?.kind === 'drive') return entry.location.fileId
  throw new Error(`"${entry.name}" is not in Google Drive`)
}

/** The handle of an entry in a folder on this computer. */
function localHandleOf(entry: ExplorerEntry): FileSystemHandle {
  if (entry.folder?.kind === 'local') return entry.folder.handle
  if (entry.location?.kind === 'local') return entry.location.handle
  throw new Error(`"${entry.name}" is not on this computer`)
}

/** Gives a folder or project file in `parent` a new name. */
export async function renameEntry(parent: FolderRef, entry: ExplorerEntry, name: string) {
  const fileName = entry.folder ? name : fileNameOf(name)
  if (parent.kind === 'drive') {
    await renameItem(driveIdOf(entry), fileName)
    return
  }
  const handle = localHandleOf(entry)
  if (handle.move) return handle.move(fileName)
  if (entry.folder) throw new Error('this browser cannot rename folders')
  // Without move(): a renamed copy, then the original goes.
  const text = await (await (handle as FileSystemFileHandle).getFile()).text()
  await writeLocal(parent.handle, fileName, text)
  await parent.handle.removeEntry(entry.fileName)
}

/** Removes a folder (with what is in it) or a project file. In Drive it goes to the trash; on this computer it is gone. */
export async function removeEntry(parent: FolderRef, entry: ExplorerEntry) {
  if (parent.kind === 'local') return parent.handle.removeEntry(entry.fileName, { recursive: true })
  await trashItem(driveIdOf(entry))
}

async function writeLocal(folder: FileSystemDirectoryHandle, fileName: string, text: string): Promise<FileSystemFileHandle> {
  const handle = await folder.getFileHandle(fileName, { create: true })
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
  return handle
}

/** Saves project `text` as `name` in `folder`, over `existing` when given. Returns where it went. */
export async function saveInFolder(folder: FolderRef, name: string, text: string, existing?: ExplorerEntry): Promise<ProjectLocation> {
  if (folder.kind === 'local') return { kind: 'local', handle: await writeLocal(folder.handle, existing?.fileName ?? fileNameOf(name), text) }
  const target = existing?.location?.kind === 'drive' ? { id: existing.location.fileId } : { parentId: folder.id }
  const written = await writeFile(fileNameOf(name), text, target)
  return { kind: 'drive', fileId: written.id, version: written.version }
}
