import { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'

const SHORTCUTS: [string, string][] = [
  ['V / H', 'Select / pan tool'],
  ['Drag an island edge', 'Move it; a neighbour along it follows. Lines up with nearby edges of other islands'],
  ['+ on a hovered edge', 'Grow the island 2.5 mm on that side'],
  ['Click, Shift+click', 'Select, add to selection'],
  ['Drag empty space', 'Marquee select (Shift adds)'],
  ['Ctrl+A', 'Select all'],
  ['M', 'Anchor leads on/off: dragging a part leaves its lead ends in place'],
  ['Shift+drag part', 'Take the leads along while anchored'],
  ['Drag a lead end', 'Bend the lead'],
  ['Space / Shift+Space', 'Rotate 90° / 15°'],
  ['Del', 'Remove the selected rectangle'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'],
  ['Ctrl+O / Ctrl+N', 'Open a project / new project, in a new tab'],
  ['Middle-drag, wheel', 'Pan, zoom'],
  ['F', 'Fit the board in view'],
  ['W (schematic)', 'Wire tool: drag for one wire, or click corner by corner; double-click or Esc stops'],
  ['X / Y (schematic)', 'Mirror the selected symbols left to right / top to bottom'],
  ['Space while drawing', 'Flip which leg of the wire comes first'],
  ['Drag from a pin end', 'Draw a wire without switching tools (Shift: from a wire end)'],
  ['Drag right / left (schematic)', 'Select what lies inside the rectangle / what it touches'],
  ['Drag (schematic)', 'Drag the selection; wires around it stretch along, connections stay'],
  ['Shift+drag (schematic)', 'Move only the selection; connections across its edge break'],
  ['Drag a wire, a corner', 'A wire alone shifts sideways; a corner or junction takes its wire ends along'],
  ['L (schematic)', 'Label tool: click a point to name its net'],
  ['Del (schematic)', 'Remove the selected wires and labels'],
  ['Double-click a label', 'Rename it'],
]

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <header>
        <h2><Icon name="help" />Shortcuts</h2>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([keys, action]) => (
            <tr key={keys}>
              <th>{keys}</th>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </dialog>
  )
}

/** A question with a button per answer. The last choice is the default; Escape answers `cancel`. */
export interface Question<Answer extends string> {
  title: string
  text: string
  choices: { answer: Answer; label: string }[]
  cancel: Answer
}

export function QuestionDialog<Answer extends string>({ question, onAnswer }: { question: Question<Answer>; onAnswer: (answer: Answer) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])
  const last = question.choices.length - 1

  return (
    <dialog ref={dialogRef} className="dialog question-dialog" onCancel={() => onAnswer(question.cancel)}>
      <h2>{question.title}</h2>
      <p>{question.text}</p>
      <div className="dialog-actions">
        {question.choices.map(({ answer, label }, k) => (
          <button key={answer} className={k === last ? 'primary' : undefined} onClick={() => onAnswer(answer)} autoFocus={k === last}>
            {label}
          </button>
        ))}
      </div>
    </dialog>
  )
}

const MCP_ADD_COMMAND = 'claude mcp add manhattan -- npx -y github:vanBassum/manhattan-layout-editor'
const MCP_JSON_CONFIG = '{"mcpServers": {"manhattan": {"command": "npx", "args": ["-y", "github:vanBassum/manhattan-layout-editor"]}}}'
const EXAMPLE_PROMPT = 'Make a compact, easy to solder layout for the circuit open in the Manhattan editor.'

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked; the text is still selectable.
    }
  }
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

export function AiHelpDialog({ agentConnected, onClose }: { agentConnected: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  // A modal <dialog> gives Escape-to-close, a backdrop and focus trapping for free.
  useEffect(() => dialogRef.current?.showModal(), [])

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <header>
        <h2><Icon name="ai" />Use your AI assistant</h2>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>
      <p>
        An AI assistant with MCP support (Claude Code, Claude Desktop, Cursor, …) can inspect and edit this layout:
        move parts, reshape islands, check problems and take screenshots. Everything stays in this browser tab.
      </p>
      <p className={agentConnected ? 'badge ok' : 'badge warn'}>
        {agentConnected ? 'An assistant is connected to this page' : 'No assistant connected yet'}
      </p>
      <ol>
        <li>
          Register the MCP server once (needs Node.js 18+):
          <CopyLine text={MCP_ADD_COMMAND} />
          <span className="muted">Other clients, JSON config:</span>
          <CopyLine text={MCP_JSON_CONFIG} />
        </li>
        <li>Keep this page open. The Menu button gets a green dot once the assistant runs.</li>
        <li>
          Ask it, for example:
          <CopyLine text={EXAMPLE_PROMPT} />
        </li>
      </ol>
      <p className="muted">
        Chrome may ask to allow access to your local network: allow it. Safari does not support this connection.
        Commands go to the most recently opened editor tab. Assistants given only the site link can read{' '}
        <a href="llms.txt" target="_blank" rel="noreferrer">llms.txt</a>.
      </p>
    </dialog>
  )
}
