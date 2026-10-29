// Connection to the local MCP server (mcp/server.mjs), which forwards an AI agent's tool calls.
// The page executes each command on its own state and sends back the result.

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
      const { id, command, args } = JSON.parse(String(event.data))
      try {
        const result = await handle(command, args ?? {})
        socket?.send(JSON.stringify({ id, result }))
      } catch (e) {
        socket?.send(JSON.stringify({ id, error: e instanceof Error ? e.message : String(e) }))
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
