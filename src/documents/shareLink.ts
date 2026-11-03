import type { Project } from '../model/types'
import { projectFromFile, projectToFile } from './projectFormat'

// A share link carries the whole project in the URL fragment, deflated and base64url-encoded. The
// fragment never goes to a server, so the project only travels with the link itself.

const SHARE_PREFIX = '#share='

async function deflated(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function inflated(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// atob accepts base64 without its trailing padding.
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export async function shareLinkOf(project: Project): Promise<string> {
  const data = toBase64Url(await deflated(projectToFile(project)))
  return `${location.origin}${location.pathname}${SHARE_PREFIX}${data}`
}

/** The project in the page's share link, if it has one. The link is taken off the address bar, so a reload does not open it again. */
export async function takeSharedProject(): Promise<Project | null> {
  if (!location.hash.startsWith(SHARE_PREFIX)) return null
  const data = location.hash.slice(SHARE_PREFIX.length)
  history.replaceState(null, '', location.pathname + location.search)
  return projectFromFile(await inflated(fromBase64Url(data)))
}
