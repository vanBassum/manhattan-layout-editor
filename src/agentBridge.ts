// Connection to the local MCP server (mcp/server.mjs), which forwards an AI agent's tool calls.
// The page executes each command on its own state and sends back the result.

import { errorText } from './errorText'

const BRIDGE_URL = 'ws://127.0.0.1:5174'
const MIN_RETRY_MS = 2000
const MAX_RETRY_MS = 15000

export type AgentCommandHandler = (command: string, args: Record<string, unknown>) => unknown

/**
 * Keeps trying to connect, backing off while no server is running (each failed attempt shows up
 * in the browser console; that is harmless). Returns a function that disconnects for good.
 */
export function connectAgentBridge(handle: AgentCommandHandler, onStatus: (connected: boolean) => void): () => void {
  let socket: WebSocket | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryMs = MIN_RETRY_MS
  let stopped = false

  const connect = () => {
    socket = new WebSocket(BRIDGE_URL)
    socket.onopen = () => {
      retryMs = MIN_RETRY_MS
      onStatus(true)
    }
    socket.onclose = () => {
      onStatus(false)
      if (stopped) return
      retryTimer = setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
    }
    socket.onmessage = async (event) => {
      let message: { id: unknown; command: string; args?: Record<string, unknown> }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        // Without an id there is no request to answer; the server times it out.
        console.error('Ignored a message from the MCP server that is not JSON:', event.data)
        return
      }
      const { id, command, args } = message
      try {
        const result = await handle(command, args ?? {})
        socket?.send(JSON.stringify({ id, result }))
      } catch (e) {
        socket?.send(JSON.stringify({ id, error: errorText(e) }))
      }
    }
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(retryTimer)
    socket?.close()
  }
}
