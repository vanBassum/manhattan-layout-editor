// Google sign-in and Google Drive, over plain fetch. Projects live in folders the user picks in their
// Drive (googlePicker.ts). The editor only sees what it made itself and what the user picked (scope
// drive.file), never the rest of the user's Drive. Nothing is loaded from Google until someone
// chooses Google Drive: the sign-in script is only added then.

const CLIENT_ID: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID
export const PICKER_API_KEY: string = import.meta.env.VITE_GOOGLE_API_KEY ?? ''
// The picker wants the Cloud project number, which starts the client id.
export const PICKER_APP_ID = CLIENT_ID?.split('-')[0] ?? ''
/** Google Drive is only offered by builds that have a Google OAuth client id and an API key for the picker. */
export const driveConfigured = Boolean(CLIENT_ID && PICKER_API_KEY)

const SCOPES = ['https://www.googleapis.com/auth/drive.file']
const SIGN_IN_SCRIPT = 'https://accounts.google.com/gsi/client'
const API = 'https://www.googleapis.com'
const TOKEN_KEY = 'manhattan-layout-editor/drive-token'
const SIGN_IN_CHECK_MS = 30_000

interface TokenResponse {
  access_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

interface GoogleOAuth {
  initTokenClient(config: {
    client_id: string
    scope: string
    callback: (response: TokenResponse) => void
    error_callback: (error: { type: string; message?: string }) => void
  }): { requestAccessToken(): void }
}

declare global {
  interface Window {
    google?: { accounts: { oauth2: GoogleOAuth } }
  }
}

interface StoredToken {
  accessToken: string
  expiresAt: number
  /** The scopes Google granted, space-separated. */
  scope?: string
}

// The token is in localStorage so all browser tabs share one sign-in, and a reload keeps it. Google
// gives browser apps no refresh token: after an hour the user signs in again with a click.
function readToken(): StoredToken | null {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as StoredToken | null
  } catch {
    return null
  }
}

/** The access token, or null when signed out, expired, or granted without all the scopes (as by older versions). */
function accessToken(): string | null {
  const token = readToken()
  if (!token || token.expiresAt <= Date.now()) return null
  return SCOPES.every((scope) => token.scope?.includes(scope)) ? token.accessToken : null
}

export const isSignedIn = () => accessToken() !== null
export const currentAccessToken = accessToken

const signInListeners = new Set<() => void>()
const notifySignIn = () => signInListeners.forEach((listener) => listener())
let watchingSignIn = false

/** Called when the sign-in may have changed: here, in another browser tab, or by running out. Returns the unsubscribe. */
export function onSignInChange(listener: () => void) {
  if (!watchingSignIn) {
    watchingSignIn = true
    window.addEventListener('storage', (e) => {
      if (e.key === TOKEN_KEY) notifySignIn()
    })
    setInterval(notifySignIn, SIGN_IN_CHECK_MS)
  }
  signInListeners.add(listener)
  return () => void signInListeners.delete(listener)
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
  notifySignIn()
}

let signInScript: Promise<GoogleOAuth> | null = null

function loadSignInScript(): Promise<GoogleOAuth> {
  signInScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SIGN_IN_SCRIPT
    script.onload = () => resolve(window.google!.accounts.oauth2)
    script.onerror = () => {
      signInScript = null
      script.remove()
      reject(new Error('Google sign-in could not be loaded'))
    }
    document.head.append(script)
  })
  return signInScript
}

/** Asks Google for access. Call it from a click: it opens Google's sign-in window. */
export async function signIn() {
  if (!CLIENT_ID) throw new Error('this build has no Google client id')
  const oauth = await loadSignInScript()
  const response = await new Promise<TokenResponse>((resolve, reject) =>
    oauth
      .initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES.join(' '),
        callback: resolve,
        error_callback: (error) => reject(new Error(error.message ?? error.type)),
      })
      .requestAccessToken(),
  )
  if (!response.access_token || !response.expires_in) throw new Error(response.error_description ?? response.error ?? 'Google gave no access')
  const missing = SCOPES.filter((scope) => !response.scope?.includes(scope))
  if (missing.length > 0) throw new Error('Google Drive access was not granted; allow it in the sign-in window')
  // A minute early, so a save never starts with a token that runs out halfway.
  const token: StoredToken = { accessToken: response.access_token, expiresAt: Date.now() + (response.expires_in - 60) * 1000, scope: response.scope }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  notifySignIn()
}

/** Forgets the token here and tells Google to revoke it. */
export function signOut() {
  const token = readToken()?.accessToken
  forgetToken()
  if (token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {})
}

/** Google no longer accepts the token: the user has to sign in again. */
export class SignInNeeded extends Error {
  constructor() {
    super('Sign in with Google first')
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = accessToken()
  if (!token) throw new SignInNeeded()
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
  if (response.status === 401) {
    forgetToken()
    throw new SignInNeeded()
  }
  if (response.status === 404) throw new Error('it is no longer in Google Drive')
  if (!response.ok) throw new Error(`Google Drive answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response
}

const json = async <T,>(response: Promise<Response>) => (await (await response).json()) as T

/** A file or folder in Google Drive; `version` goes up with every change to it. */
export interface DriveItem {
  id: string
  name: string
  mimeType: string
  version: string
  modifiedTime: string
  /** Bytes, for files. */
  size?: string
}

const ITEM_FIELDS = 'id,name,mimeType,version,modifiedTime,size'
// Drive queries put names between single quotes.
const quoted = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

async function search(q: string): Promise<DriveItem[]> {
  const items: DriveItem[] = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ q, fields: `nextPageToken,files(${ITEM_FIELDS})`, pageSize: '1000', orderBy: 'folder,name' })
    if (pageToken) query.set('pageToken', pageToken)
    const page = await json<{ files: DriveItem[]; nextPageToken?: string }>(call(`/drive/v3/files?${query}`))
    items.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return items
}

/** The file called `name` in folder `folderId`, if the editor can see one there. */
export async function findFile(folderId: string, name: string): Promise<DriveItem | undefined> {
  return (await search(`${quoted(folderId)} in parents and name = ${quoted(name)} and trashed = false`))[0]
}

export async function readFile(id: string): Promise<string> {
  return (await call(`/drive/v3/files/${id}?alt=media`)).text()
}

/** Drive's current version of file `id`, to tell whether it changed since it was opened or saved here. */
export async function fileVersion(id: string): Promise<string> {
  return (await json<{ version: string }>(call(`/drive/v3/files/${id}?fields=version`))).version
}

/** The file's name and current version. */
export async function fileInfo(id: string): Promise<{ name: string; version: string }> {
  return json<{ name: string; version: string }>(call(`/drive/v3/files/${id}?fields=name,version`))
}

/** Writes `text` to file `id`, which keeps its name, or to a new file `name` in folder `parentId`. */
export async function writeFile(text: string, target: { id: string } | { parentId: string; name: string }): Promise<DriveItem> {
  // Drive takes the metadata and the content in one multipart request.
  const boundary = `manhattan-${crypto.randomUUID()}`
  const metadata = 'id' in target ? {} : { name: target.name, parents: [target.parentId] }
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`
  const path = 'id' in target ? `/upload/drive/v3/files/${target.id}` : '/upload/drive/v3/files'
  return json<DriveItem>(
    call(`${path}?uploadType=multipart&fields=${ITEM_FIELDS}`, {
      method: 'id' in target ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }),
  )
}
