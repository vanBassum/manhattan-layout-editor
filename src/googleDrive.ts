// Google sign-in and the editor's hidden folder in the user's Google Drive (the app data folder),
// over plain fetch. Nothing is loaded from Google until someone chooses to sync: the sign-in script
// is only added to the page on the first sign-in.

const CLIENT_ID: string | undefined = import.meta.env.VITE_GOOGLE_CLIENT_ID
/** Drive sync is only offered by builds that have a Google OAuth client id. */
export const driveConfigured = Boolean(CLIENT_ID)

// Only the app data folder: the editor sees nothing else in the user's Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const SIGN_IN_SCRIPT = 'https://accounts.google.com/gsi/client'
const API = 'https://www.googleapis.com'
export const TOKEN_KEY = 'manhattan-layout-editor/drive-token'

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
export function accessToken(): string | null {
  const token = readToken()
  return token && token.expiresAt > Date.now() ? token.accessToken : null
}

function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
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

/** Asks Google for access to the app data folder. Call it from a click: it opens Google's sign-in window. */
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
  // A minute early, so a sync never starts with a token that runs out halfway.
  const token: StoredToken = { accessToken: response.access_token, expiresAt: Date.now() + (response.expires_in - 60) * 1000 }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token))
}

/** Forgets the token here and tells Google to revoke it. */
export function signOut() {
  const token = accessToken()
  forgetToken()
  if (token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {})
}

/** Google no longer accepts the token; syncing waits for the user to sign in again. */
export class SignInNeeded extends Error {}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = accessToken()
  if (!token) throw new SignInNeeded('Google sign-in expired')
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } })
  if (response.status === 401) {
    forgetToken()
    throw new SignInNeeded('Google sign-in expired')
  }
  if (!response.ok) throw new Error(`Google Drive answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response
}

/** A file in the app data folder; `version` goes up with every change to it. */
export interface DriveFile {
  id: string
  name: string
  version: string
}

/** The app data folder, as the sync uses it; tests stand in a folder in memory. */
export interface AppFolder {
  list(): Promise<DriveFile[]>
  read(id: string): Promise<string>
  /** Writes `text` to file `id`, or to a new file `name` without an id. */
  write(name: string, text: string, id?: string): Promise<DriveFile>
  remove(id: string): Promise<void>
}

const FILE_FIELDS = 'id,name,version'

export const googleAppFolder: AppFolder = {
  async list() {
    const files: DriveFile[] = []
    let pageToken = ''
    do {
      const query = new URLSearchParams({ spaces: 'appDataFolder', fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000' })
      if (pageToken) query.set('pageToken', pageToken)
      const page = (await (await call(`/drive/v3/files?${query}`)).json()) as { files: DriveFile[]; nextPageToken?: string }
      files.push(...page.files)
      pageToken = page.nextPageToken ?? ''
    } while (pageToken)
    return files
  },

  async read(id) {
    return (await call(`/drive/v3/files/${id}?alt=media`)).text()
  },

  async write(name, text, id) {
    if (!id) {
      const created = await call('/drive/v3/files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: ['appDataFolder'] }),
      })
      id = ((await created.json()) as { id: string }).id
    }
    const written = await call(`/upload/drive/v3/files/${id}?uploadType=media&fields=${FILE_FIELDS}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    })
    return (await written.json()) as DriveFile
  },

  async remove(id) {
    await call(`/drive/v3/files/${id}`, { method: 'DELETE' })
  },
}
