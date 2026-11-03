// Google sign-in and the editor's own folder in the user's Google Drive (the hidden app data
// folder), over plain fetch. Each project saved there is one document. Nothing is loaded from
// Google until someone chooses Google Drive: the sign-in script is only added on the first sign-in.

const CLIENT_ID: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID
/** Google Drive is only offered by builds that have a Google OAuth client id. */
export const driveConfigured = Boolean(CLIENT_ID)

// Only the app data folder: the editor sees nothing else in the user's Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const SIGN_IN_SCRIPT = 'https://accounts.google.com/gsi/client'
const API = 'https://www.googleapis.com'
const TOKEN_KEY = 'manhattan-layout-editor/drive-token'
const DOCUMENT_SUFFIX = '.manhattan.json'
const SIGN_IN_CHECK_MS = 30_000

interface TokenResponse {
  access_token?: string
  expires_in?: number
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

/** The access token, or null when signed out or expired. */
function accessToken(): string | null {
  const token = readToken()
  return token && token.expiresAt > Date.now() ? token.accessToken : null
}

export const isSignedIn = () => accessToken() !== null

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

/** Asks Google for access to the editor's folder. Call it from a click: it opens Google's sign-in window. */
export async function signIn() {
  if (!CLIENT_ID) throw new Error('this build has no Google client id')
  const oauth = await loadSignInScript()
  const response = await new Promise<TokenResponse>((resolve, reject) =>
    oauth
      .initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: resolve,
        error_callback: (error) => reject(new Error(error.message ?? error.type)),
      })
      .requestAccessToken(),
  )
  if (!response.access_token || !response.expires_in) throw new Error(response.error_description ?? response.error ?? 'Google gave no access')
  // A minute early, so a save never starts with a token that runs out halfway.
  const token: StoredToken = { accessToken: response.access_token, expiresAt: Date.now() + (response.expires_in - 60) * 1000 }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
  notifySignIn()
}

/** Forgets the token here and tells Google to revoke it. */
export function signOut() {
  const token = accessToken()
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
  if (response.status === 404) throw new Error('the document is no longer in Google Drive')
  if (!response.ok) throw new Error(`Google Drive answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response
}

/** A project document in the editor's folder; `version` goes up with every change to it. */
export interface DriveDocument {
  id: string
  name: string
  version: string
  modifiedTime: string
}

/** A file as Drive lists it; a document's file name is its name plus the suffix. */
type DriveFile = DriveDocument

const FILE_FIELDS = 'id,name,version,modifiedTime'
const documentName = (fileName: string) => fileName.replace(/\.manhattan\.json$/i, '')
const asDocument = (file: DriveFile): DriveDocument => ({ ...file, name: documentName(file.name) })

/** Every file in the editor's folder, documents or not. */
export async function listFiles(): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken = ''
  do {
    const query = new URLSearchParams({ spaces: 'appDataFolder', fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000', orderBy: 'modifiedTime desc' })
    if (pageToken) query.set('pageToken', pageToken)
    const page = (await (await call(`/drive/v3/files?${query}`)).json()) as { files: DriveFile[]; nextPageToken?: string }
    files.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return files
}

/** The project documents in the editor's folder, most recently changed first. */
export async function listDocuments(): Promise<DriveDocument[]> {
  const files = await listFiles()
  return files.filter((file) => file.name.endsWith(DOCUMENT_SUFFIX)).map(asDocument)
}

export async function readDocument(id: string): Promise<string> {
  return (await call(`/drive/v3/files/${id}?alt=media`)).text()
}

/** Drive's current version of document `id`, to tell whether it changed since it was opened or saved here. */
export async function documentVersion(id: string): Promise<string> {
  return ((await (await call(`/drive/v3/files/${id}?fields=version`)).json()) as { version: string }).version
}

/** Writes project `name` to document `id`, or to a new document without an id. The file name follows the project name. */
export async function writeDocument(name: string, text: string, id?: string): Promise<DriveDocument> {
  // Drive takes the name and the content in one multipart request.
  const boundary = `manhattan-${crypto.randomUUID()}`
  const metadata = id ? { name: `${name}${DOCUMENT_SUFFIX}` } : { name: `${name}${DOCUMENT_SUFFIX}`, parents: ['appDataFolder'] }
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`
  const path = id ? `/upload/drive/v3/files/${id}` : '/upload/drive/v3/files'
  const response = await call(`${path}?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  return asDocument((await response.json()) as DriveFile)
}

export async function renameDocument(id: string, name: string) {
  await call(`/drive/v3/files/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${name}${DOCUMENT_SUFFIX}` }),
  })
}

export async function removeFile(id: string) {
  await call(`/drive/v3/files/${id}`, { method: 'DELETE' })
}
