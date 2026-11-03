// Google's own file picker, for choosing a folder or project anywhere in the user's Drive. With
// scope drive.file the editor only sees what it made itself, and what the user picks here.

import { currentAccessToken, PICKER_API_KEY, PICKER_APP_ID, SignInNeeded } from './googleDrive'

const PICKER_SCRIPT = 'https://apis.google.com/js/api.js'
const FOLDER_TYPE = 'application/vnd.google-apps.folder'

export interface PickedDocument {
  id: string
  name: string
  mimeType: string
}

export const isPickedFolder = (picked: PickedDocument) => picked.mimeType === FOLDER_TYPE

interface PickerResponse {
  action: string
  docs?: PickedDocument[]
}

interface DocsView {
  setIncludeFolders(include: boolean): DocsView
  setSelectFolderEnabled(enabled: boolean): DocsView
  setMimeTypes(types: string): DocsView
  setMode(mode: string): DocsView
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
  ViewId: { DOCS: string }
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

// The views start at My Drive. Starting in another folder (setParent) would lock the user in there:
// the picker offers no way up.

/** A folder to save in, or a project file to save over, anywhere in the user's Drive; null when cancelled. */
// Projects show too, as in the computer's own save dialog: picking one saves over it.
export const pickDriveSaveTarget = () =>
  pick('Choose a folder, or a project to replace', (api) =>
    new api.DocsView(api.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes(`${FOLDER_TYPE},application/json`)
      .setMode(api.DocsViewMode.LIST),
  )

/** A project file anywhere in the user's Drive, or null when cancelled. */
export const pickDriveFile = () =>
  pick('Open a project', (api) => new api.DocsView(api.ViewId.DOCS).setIncludeFolders(true).setMimeTypes('application/json').setMode(api.DocsViewMode.LIST))
