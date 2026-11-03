// Project files on this computer through the File System Access API (Chromium browsers). Elsewhere
// the editor falls back to downloading and uploading.

import { projectFromFile, projectToFile, type ProjectFile } from './projectStore'
import type { Project } from './types'

// Not in TypeScript's DOM types yet.
declare global {
  interface Window {
    showOpenFilePicker?: (options?: FilePickerOptions) => Promise<FileSystemFileHandle[]>
    showSaveFilePicker?: (options?: FilePickerOptions & { suggestedName?: string }) => Promise<FileSystemFileHandle>
  }
  interface FileSystemHandle {
    queryPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  }
}

interface FilePickerOptions {
  types?: { description: string; accept: Record<string, string[]> }[]
  /** Pickers with the same id share the folder the user last picked in. */
  id?: string
  /** Where a picker starts until it has a folder of its own to remember. */
  startIn?: 'documents' | 'downloads' | 'desktop'
}

// A page cannot name a folder such as Documents\Manhattan itself. Open and Save share one id,
// so after the first pick both start in the folder the projects are kept in.
const PICKER_OPTIONS: FilePickerOptions = {
  types: [{ description: 'Manhattan project', accept: { 'application/json': ['.json'] } }],
  id: 'manhattan-projects',
  startIn: 'documents',
}

// globalThis.window: tests run without a window.
export const canUseFiles = typeof globalThis.window?.showOpenFilePicker === 'function' && typeof globalThis.window?.showSaveFilePicker === 'function'

const isCancel = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** The chosen file, or null when the user cancelled. */
export async function pickFileToOpen(): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await window.showOpenFilePicker!(PICKER_OPTIONS)
    return handle
  } catch (e) {
    if (isCancel(e)) return null
    throw e
  }
}

/** The chosen file, or null when the user cancelled. */
export async function pickFileToSave(suggestedName: string): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker!({ ...PICKER_OPTIONS, suggestedName })
  } catch (e) {
    if (isCancel(e)) return null
    throw e
  }
}

/**
 * Whether the editor may read and write the file. After a reload the browser asks again; it only
 * shows that question while handling a click or key press, so `ask` is for those moments.
 */
export async function mayUse(handle: FileSystemFileHandle, ask: boolean): Promise<boolean> {
  const mode = { mode: 'readwrite' } as const
  if ((await handle.queryPermission(mode)) === 'granted') return true
  return ask && (await handle.requestPermission(mode)) === 'granted'
}

export async function readFile(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text()
}

export async function writeFile(handle: FileSystemFileHandle, text: string) {
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

/**
 * A saved document's project and its content as the editor would save it, so it compares with what
 * the editor saved even when the document came from an older version; `project` is null when unreadable.
 */
export function readSavedProject(text: string): { project: Project | null; content: string } {
  try {
    const project = projectFromFile(text)
    return { project, content: projectToFile(project) }
  } catch {
    return { project: null, content: text }
  }
}

/**
 * Writes `project` to `handle`, or to a file the user picks without one. A file that changed on
 * disk since `savedContent` is only overwritten when `confirmOverwrite` says so. Returns the file
 * written, or null when nothing was saved.
 */
export async function saveLocalFile(
  project: Project,
  handle: FileSystemFileHandle | undefined,
  savedContent: string,
  confirmOverwrite: (name: string) => Promise<boolean>,
): Promise<FileSystemFileHandle | null> {
  if (handle) {
    if (!(await mayUse(handle, true))) return null
    const onDisk = await readFile(handle).then(readSavedProject, () => null)
    const changedOnDisk = onDisk !== null && onDisk.content !== savedContent
    if (changedOnDisk && !(await confirmOverwrite(handle.name))) return null
  } else {
    handle = (await pickFileToSave(`${project.name}.manhattan.json`)) ?? undefined
    if (!handle) return null
  }
  await writeFile(handle, projectToFile(project))
  return handle
}

/** How a saved document stands against its tab's recovery copy. */
export type FileComparison =
  | { kind: 'unchanged'; content: string }
  /** Changed elsewhere while the tab has no unsaved changes: the saved version can simply be shown. */
  | { kind: 'newer'; project: Project; content: string }
  /** Changed on both sides: the user picks. */
  | { kind: 'conflict'; project: Project; content: string }

/** Compares the saved document's `text` with the tab. Throws when it is no project anymore. */
export function compareSaved(text: string, file: ProjectFile): FileComparison {
  const saved = readSavedProject(text)
  if (saved.content === file.savedContent) return { kind: 'unchanged', content: saved.content }
  if (!saved.project) throw new Error('it is not a Manhattan project anymore')
  return { kind: file.dirty ? 'conflict' : 'newer', project: saved.project, content: saved.content }
}

/** Throws when the file cannot be read or is no project anymore. */
export async function compareWithFile(handle: FileSystemFileHandle, file: ProjectFile): Promise<FileComparison> {
  return compareSaved(await readFile(handle), file)
}

/** "amp.manhattan.json" → "amp". */
export const fileLabel = (handle: FileSystemFileHandle) => handle.name.replace(/(\.manhattan)?\.json$/i, '')
