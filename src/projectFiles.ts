// Project files on disk through the File System Access API (Chromium browsers). Elsewhere the
// editor falls back to downloading and uploading.

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
}

const PICKER_OPTIONS: FilePickerOptions = { types: [{ description: 'Manhattan project', accept: { 'application/json': ['.json'] } }] }

export const canUseFiles = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function'

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

/** "amp.manhattan.json" → "amp". */
export const fileLabel = (handle: FileSystemFileHandle) => handle.name.replace(/(\.manhattan)?\.json$/i, '')
