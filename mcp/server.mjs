#!/usr/bin/env node
// MCP server that lets an AI agent inspect and edit the layout open in the browser editor.
//
// Claude Code starts this over stdio (see .mcp.json). The editor page connects to the WebSocket
// below; every tool call is forwarded to the page, which applies it to its own state (with undo)
// and answers. The browser stays the single source of truth, so nothing here keeps layout state.
//
// stdout belongs to the MCP protocol: log to stderr only.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebSocketServer } from 'ws'
import { z } from 'zod'

const BRIDGE_PORT = Number(process.env.MANHATTAN_BRIDGE_PORT ?? 5174)
// Pages that may act as the editor: the local dev server, plus the published GitHub Pages site.
// MANHATTAN_ALLOWED_ORIGINS (comma separated) replaces the published-site entry.
const ALLOWED_ORIGINS = (process.env.MANHATTAN_ALLOWED_ORIGINS ?? 'https://vanbassum.github.io')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const isAllowedOrigin = (origin) =>
  !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || ALLOWED_ORIGINS.includes(origin)
const REQUEST_TIMEOUT_MS = 30_000
const log = (...args) => console.error('[manhattan-mcp]', ...args)

// ---------- Bridge to the editor page ----------

// Every open editor tab stays connected (closing one would make it reconnect and push the other
// out, endlessly); commands go to the tab that connected most recently.
const editors = []
const activeEditor = () => editors[editors.length - 1] ?? null
let nextId = 1
const pending = new Map()

// Another Claude Code session may already run this server and hold the port. Keep retrying so this
// session takes over the editor as soon as that one exits.
const BIND_RETRY_MS = 5_000
let portInUse = false

function startBridge() {
  const bridge = new WebSocketServer({
    host: '127.0.0.1',
    port: BRIDGE_PORT,
    // Only known pages may act as the editor: a page that connects gets to answer the agent's tool calls.
    verifyClient: ({ origin }) => isAllowedOrigin(origin),
  })
  bridge.on('listening', () => {
    portInUse = false
    log(`bridge listening on port ${BRIDGE_PORT}`)
  })
  bridge.on('connection', acceptEditor)
  bridge.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') {
      log('bridge error:', error.message)
      return
    }
    if (!portInUse) log(`port ${BRIDGE_PORT} is in use, retrying every ${BIND_RETRY_MS / 1000} s`)
    portInUse = true
    bridge.close()
    setTimeout(startBridge, BIND_RETRY_MS)
  })
}

function acceptEditor(socket) {
  editors.push(socket)
  log(`editor connected (${editors.length} open)`)
  socket.on('message', (data) => {
    const message = JSON.parse(String(data))
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.result)
  })
  socket.on('close', () => {
    editors.splice(editors.indexOf(socket), 1)
    log(`editor disconnected (${editors.length} open)`)
  })
}

startBridge()

function callEditor(command, args = {}) {
  const editor = activeEditor()
  if (!editor && portInUse) {
    return Promise.reject(
      new Error(
        `Port ${BRIDGE_PORT} is held by another Manhattan MCP server, probably from another Claude Code session, ` +
          'so the editor talks to that one. Close that session; this server takes over within a few seconds ' +
          'and the editor reconnects on its own.',
      ),
    )
  }
  if (!editor) {
    return Promise.reject(
      new Error('The layout editor is not connected. Open it in a browser (pnpm dev, http://localhost:5173) and try again.'),
    )
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`The editor did not answer "${command}" within ${REQUEST_TIMEOUT_MS / 1000} s.`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    editor.send(JSON.stringify({ id, command, args }))
  })
}

// ---------- Tools ----------

const server = new McpServer({ name: 'manhattan-layout-editor', version: '0.1.0' })

const asText = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
const asError = (error) => ({ content: [{ type: 'text', text: error.message }], isError: true })

// Every tool works on any open project tab, not only the one shown on screen.
const projectArg = {
  project: z
    .string()
    .optional()
    .describe('project tab to work on, by name or id (see list_projects); default: the tab shown in the editor'),
}

/** Registers a tool that forwards its arguments to the editor and returns the answer as JSON. */
function forward(name, description, inputSchema = {}) {
  server.registerTool(name, { description, inputSchema: { ...inputSchema, ...projectArg } }, async (args) => {
    try {
      return asText(await callEditor(name, args))
    } catch (error) {
      return asError(error)
    }
  })
}

server.registerTool(
  'list_projects',
  {
    description:
      'The project tabs open in the editor: id, name and whether it is the tab shown on screen. Pass a name or id ' +
      'as "project" to any other tool to work on that tab without switching to it.',
    inputSchema: {},
  },
  async () => {
    try {
      return asText(await callEditor('list_projects'))
    } catch (error) {
      return asError(error)
    }
  },
)

const point = { x: z.number().describe('mm'), y: z.number().describe('mm, y points down') }
const rect = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })

forward(
  'get_layout',
  'Everything about the current layout, all in millimeters (y points down): nets with their pins, ' +
    'components (position, rotation, body outline, each pin with its net, lead anchor and lead end, and whether ' +
    'the lead end sits on its own island), copper islands as rectangles, and the problems found ' +
    '(open pins, shorted pins, nets too close = islands of different nets overlapping, nets split into pieces). ' +
    'Islands of different nets touch edge to edge without gaps; the isolation cut is burned centered on their ' +
    'shared edge, so the copper is each island shrunk by isolation/2 and a lead end must lie at least isolation/2 ' +
    'inside its island. The netlist is fixed; only geometry can change.',
)

server.registerTool(
  'screenshot',
  {
    description:
      'PNG image of the whole layout as drawn in the editor: copper islands with net names, components with ' +
      'references, leads, and dashed lines from leads that miss their island. Use it to judge the layout visually.',
    inputSchema: projectArg,
  },
  async (args) => {
    try {
      const { png } = await callEditor('screenshot', args)
      return { content: [{ type: 'image', data: png, mimeType: 'image/png' }] }
    } catch (error) {
      return asError(error)
    }
  },
)

forward(
  'move_component',
  'Moves and/or rotates a component. x/y is the component center; rotation is in degrees clockwise, any angle. ' +
    'Bent leads move along with the component. Returns the problems after the change.',
  { ref: z.string(), x: z.number().optional(), y: z.number().optional(), rotation: z.number().optional() },
)

forward(
  'set_lead_end',
  'Bends one lead so it ends at the given point (world coordinates, mm). The bend is stored relative to the ' +
    'component, so it follows later moves. Returns the problems after the change.',
  { ref: z.string(), pin: z.string().describe('pin number as in the netlist'), ...point },
)

forward('reset_leads', 'Straightens all leads of a component back to their default position.', { ref: z.string() })

forward(
  'set_island',
  "Replaces a net's copper island with the given rectangles (mm). Rectangles of one island should touch or " +
    'overlap; separate pieces count as a split net. Make neighboring islands of other nets touch (shared edge = ' +
    'cut line) rather than leaving a gap, but never overlap them; keep edges on the snap grid from get_layout ' +
    'settings. Returns the problems after the change.',
  { net: z.string(), rects: z.array(rect).min(1) },
)

forward('move_island', "Shifts a net's whole island by dx, dy (mm).", { net: z.string(), dx: z.number(), dy: z.number() })

forward(
  'run_optimizer',
  'Replaces the whole layout with the result of a built-in strategy: "knife", "knife-cuts" (knife edited as cut lines on a solid board) or "manhattan". ' +
    'Useful as a starting point to refine by hand. Can be undone.',
  { strategy: z.enum(['knife', 'knife-cuts', 'manhattan']) },
)

forward(
  'batch',
  'Applies several edits in one call, in order, as a single undo step. Each edit is ' +
    '{command, args} where command is move_component, set_lead_end, reset_leads, set_island or move_island ' +
    'and args are that tool\'s arguments. If any edit fails, nothing is changed. Returns the problems after all edits.',
  {
    edits: z
      .array(
        z.object({
          command: z.enum(['move_component', 'set_lead_end', 'reset_leads', 'set_island', 'move_island']),
          args: z.record(z.string(), z.unknown()),
        }),
      )
      .min(1),
  },
)

forward(
  'set_resistor_footprint',
  'Builds every plain resistor (R1, R2, ...; not trimmers or RL loads) as "through-hole" (the netlist footprint) ' +
    'or as a "1206" SMD chip that bridges the cut between the two islands it lies across. Resets those resistors\' bent leads. ' +
    'Does not change the netlist. Can be undone.',
  { footprint: z.enum(['through-hole', '1206']) },
)

forward(
  'set_footprint',
  'Builds the given components with another footprint, e.g. "R1206", "R0805", "R0603", "C1206", "C0805", ' +
    '"R_AXIAL-0.3", "R_AXIAL-0.4", "DO-35_BD1.9-L3.8-P7.62", "DO-41_BD2.7-L5.2-P10.16", "SOD-123_L2.7-W1.6", ' +
    '"CAP-TH_L5.5-W2.5-P5.00", "CAP-TH_BD5.0-P2.00", "CAP-TH_BD6.3-P2.50", "TO-92-3_L4.9-W3.7-P2.54-L", ' +
    '"TO-126-3_L7.6-W2.7-P2.30-L" or "SOT-23-3_L2.9-W1.3". Shape and size are read from the name, so other ' +
    'EasyEDA/KiCad-style names work too. null puts the netlist footprint back. A known footprint whose pin count ' +
    'differs from a component is refused. Nets do not change; bent leads of those components are reset. Can be undone.',
  {
    refs: z.array(z.string()).min(1).describe('component references, e.g. ["R1", "R2"]'),
    footprint: z.string().min(1).nullable().describe('footprint name, or null for the netlist footprint'),
  },
)

forward('undo', 'Undoes the last layout change (the same history as Ctrl+Z in the editor).')
forward('redo', 'Redoes the last undone layout change.')

await server.connect(new StdioServerTransport())
log(`ready; waiting for the editor on ws://127.0.0.1:${BRIDGE_PORT}`)
