// Google's own file picker, for choosing a folder or project anywhere in the user's Drive. With
// scope drive.file the editor only sees what it made itself, and what the user picks here.

import { currentAccessToken, PICKER_API_KEY, PICKER_APP_ID, SignInNeeded } from './googleDrive'

const PICKER_SCRIPT = 'https://apis.google.com/js/api.js'
const FOLDER_TYPE = 'application/vnd.google-apps.folder'
const LAST_FOLDER_KEY = 'manhattan-layout-editor/drive-folder'

export interface PickedDocument {
  id: string
  name: string
  parentId?: string
}

interface PickerResponse {
  action: string
  docs?: PickedDocument[]
}

interface DocsView {
  setIncludeFolders(include: boolean): DocsView
  setSelectFolderEnabled(enabled: boolean): DocsView
  setMimeTypes(types: string): DocsView
  setMode(mode: string): DocsView
  setParent(folderId: string): DocsView
}

interface PickerBuilder {
  addView(view: DocsView): PickerBuilder
  setOAuthToken(token: string): PickerBuilder
  setDeveloperKey(key: string): PickerBuilder
  setAppId(id: string): PickerBuilder
  setTitle(title: string): PickerBuilder
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder
  build(): { setVisible(visible: boolean): void }
}

interface PickerApi {
  DocsView: new (viewId?: string) => DocsView
  PickerBuilder: new () => PickerBuilder
  ViewId: { DOCS: string; FOLDERS: string }
  DocsViewMode: { LIST: string }
  Action: { PICKED: string; CANCEL: string }
}

declare global {
  interface Window {
    gapi?: { load(name: string, callback: () => void): void }
  }
}

let pickerApi: Promise<PickerApi> | null = null

function loadPicker(): Promise<PickerApi> {
  pickerApi ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = PICKER_SCRIPT
    script.onload = () => window.gapi!.load('picker', () => resolve((window as unknown as { google: { picker: PickerApi } }).google.picker))
    script.onerror = () => {
      pickerApi = null
      script.remove()
      reject(new Error('the Google Drive picker could not be loaded'))
    }
    document.head.append(script)
  })
  return pickerApi
}

/** Shows Google's picker with `view`; resolves with what was picked, or null when cancelled. */
async function pick(title: string, makeView: (api: PickerApi) => DocsView): Promise<PickedDocument | null> {
  const token = currentAccessToken()
  if (!token) throw new SignInNeeded()
  const api = await loadPicker()
  return new Promise((resolve) =>
    new api.PickerBuilder()
      .addView(makeView(api))
      .setOAuthToken(token)
      .setDeveloperKey(PICKER_API_KEY)
      .setAppId(PICKER_APP_ID)
      .setTitle(title)
      .setCallback((response) => {
        if (response.action === api.Action.PICKED) resolve(response.docs?.[0] ?? null)
        else if (response.action === api.Action.CANCEL) resolve(null)
      })
      .build()
      .setVisible(true),
  )
}

function lastFolder(): string | null {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY)
  } catch {
    return null
  }
}

function rememberFolder(id: string | undefined) {
  if (!id) return
  try {
    localStorage.setItem(LAST_FOLDER_KEY, id)
  } catch {}
}

/** A view that starts in the folder used last, like the computer's own file dialogs do. */
function startingInLastFolder(view: DocsView): DocsView {
  const start = lastFolder()
  return start ? view.setParent(start) : view
}

/** A folder anywhere in the user's Drive, or null when cancelled. */
export async function pickDriveFolder(): Promise<PickedDocument | null> {
  const picked = await pick('Choose the folder to save in', (api) =>
    startingInLastFolder(new api.DocsView(api.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER_TYPE)),
  )
  rememberFolder(picked?.id)
  return picked
}

/** A project file anywhere in the user's Drive, or null when cancelled. */
export async function pickDriveFile(): Promise<PickedDocument | null> {
  const picked = await pick('Open a project', (api) =>
    startingInLastFolder(new api.DocsView(api.ViewId.DOCS).setIncludeFolders(true).setMimeTypes('application/json').setMode(api.DocsViewMode.LIST)),
  )
  rememberFolder(picked?.parentId)
  return picked
}
