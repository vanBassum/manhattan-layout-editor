import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LayerMode, Layers } from './Canvas'
import type { ResistorChoice } from './layout'
import type { Netlist, Selection } from './types'

const ICON_PATHS = {
  app: 'M4 4h6v6H4z M14 14h6v6h-6z M10 7h4v10 M7 10v7h7',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  sample: 'M4 6h16v12H4z M8 10h8 M8 14h5',
  grid: 'M4 4h16v16H4z M4 12h16 M12 4v16',
  export: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  fit: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v4h-4',
  leads: 'M4 12h5 M15 12h5 M9 8h6v8H9z',
  addRect: 'M4 6h12v12H4z M19 9v6 M16 12h6',
  removeRect: 'M4 6h12v12H4z M16 12h6',
  optimize: 'M13 3L5 14h6l-1 7 8-11h-6z',
  search: 'M10 4a6 6 0 1 1 0 12a6 6 0 1 1 0-12 M15 15l5 5',
  convert: 'M4 8h14l-3-3 M20 16H6l3 3',
  plus: 'M12 5v14 M5 12h14',
  ai: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z',
}

export type IconName = keyof typeof ICON_PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d={ICON_PATHS[name]} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface SectionProps {
  title: ReactNode
  /** Grow to fill the remaining sidebar height (for long lists). */
  fill?: boolean
  children: ReactNode
}

// Not <details>: it cannot reliably act as a flex container, which a filling section needs.
export function Section({ title, fill = false, children }: SectionProps) {
  const [open, setOpen] = useState(true)
  return (
    <section className={['section', open && 'open', fill && 'fill'].filter(Boolean).join(' ')}>
      <button className="section-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}

const LAYER_LABELS: Record<keyof Layers, string> = {
  islands: 'Copper islands',
  parts: 'Components',
  netLabels: 'Net labels',
  leads: 'Leads / ratsnest',
  grid: 'Grid',
}

const LAYER_MODES: { mode: LayerMode; symbol: string; label: string }[] = [
  { mode: 'on', symbol: '●', label: 'Visible' },
  { mode: 'faded', symbol: '◐', label: 'Faded (not clickable)' },
  { mode: 'off', symbol: '○', label: 'Hidden' },
]

export function LayerToggles({ layers, onChange }: { layers: Layers; onChange: (layers: Layers) => void }) {
  return (
    <div className="layer-list">
      {(Object.keys(LAYER_LABELS) as (keyof Layers)[]).map((layer) => (
        <div key={layer} className="layer-row">
          <span className={layers[layer] === 'on' ? '' : 'muted'}>{LAYER_LABELS[layer]}</span>
          <div className="segmented" role="radiogroup" aria-label={LAYER_LABELS[layer]}>
            {LAYER_MODES.map(({ mode, symbol, label }) => (
              <button
                key={mode}
                role="radio"
                aria-checked={layers[layer] === mode}
                className={layers[layer] === mode ? 'active' : ''}
                onClick={() => onChange({ ...layers, [layer]: mode })}
                title={label}
              >
                {symbol}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const RESISTOR_TARGETS: { choice: ResistorChoice; label: string }[] = [
  { choice: '1206', label: '1206 SMD' },
  { choice: 'through-hole', label: 'Through-hole' },
]

interface Conversion {
  choice: ResistorChoice
  refs: Set<string>
}

interface ComponentListProps {
  netlist: Netlist
  selection: Selection
  onSelect: (selection: Selection) => void
  /** Plain resistors the conversion may change, and which of those are built as 1206 now. */
  convertible: ReadonlySet<string>
  convertedToSmd: ReadonlySet<string>
  onConvert: (refs: ReadonlySet<string>, choice: ResistorChoice) => void
}

export function ComponentList({ netlist, selection, onSelect, convertible, convertedToSmd, onConvert }: ComponentListProps) {
  const [query, setQuery] = useState('')
  const [conversion, setConversion] = useState<Conversion | null>(null)
  const needle = query.trim().toLowerCase()
  const shown = netlist.components.filter((c) =>
    [c.ref, c.value, c.footprint].some((text) => text.toLowerCase().includes(needle)),
  )

  // Preselect only the resistors the chosen target would actually change.
  const startConversion = (choice: ResistorChoice) =>
    setConversion({ choice, refs: new Set([...convertible].filter((ref) => convertedToSmd.has(ref) !== (choice === '1206'))) })

  const toggleRef = (ref: string) => {
    if (!conversion) return
    const refs = new Set(conversion.refs)
    if (refs.has(ref)) refs.delete(ref)
    else refs.add(ref)
    setConversion({ ...conversion, refs })
  }

  const applyConversion = () => {
    if (!conversion) return
    onConvert(conversion.refs, conversion.choice)
    setConversion(null)
  }

  const targetLabel = RESISTOR_TARGETS.find((t) => t.choice === conversion?.choice)?.label

  return (
    <>
      <label className="search">
        <Icon name="search" />
        <input type="search" placeholder="Search components" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {convertible.size > 0 && !conversion && (
        <button className="convert-start" onClick={() => startConversion('1206')} title="Choose a footprint for the plain resistors">
          <Icon name="convert" />Convert resistors…
        </button>
      )}
      {conversion && (
        <div className="conversion">
          <div className="conversion-target">
            <span>Resistors to</span>
            <div className="segmented">
              {RESISTOR_TARGETS.map(({ choice, label }) => (
                <button key={choice} className={conversion.choice === choice ? 'active' : ''} onClick={() => startConversion(choice)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="muted">
            {conversion.refs.size} of {convertible.size} checked. Their bent leads are reset.
          </p>
          <div className="conversion-actions">
            <button className="primary" disabled={conversion.refs.size === 0} onClick={applyConversion}>Apply</button>
            <button onClick={() => setConversion(null)}>Cancel</button>
          </div>
        </div>
      )}
      <ul className="component-list">
        {shown.map((c) => {
          const selected = selection?.kind === 'part' && selection.ref === c.ref
          if (conversion && convertible.has(c.ref)) {
            const checked = conversion.refs.has(c.ref)
            return (
              <li key={c.ref}>
                <label className={`convert-row${checked ? ' checked' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => toggleRef(c.ref)} />
                  <span className="ref">{c.ref}</span>
                  <span className="value">{c.value}</span>
                  <span className="footprint">{checked ? `${c.footprint} → ${targetLabel}` : c.footprint}</span>
                </label>
              </li>
            )
          }
          return (
            <li key={c.ref} className={conversion ? 'unaffected' : ''}>
              <button
                className={selected ? 'selected' : ''}
                onClick={() => onSelect({ kind: 'part', ref: c.ref })}
                title={c.footprint || undefined}
              >
                <span className="ref">{c.ref}</span>
                <span className="value">{c.value}</span>
                <span className="footprint">{c.footprint}</span>
              </button>
            </li>
          )
        })}
        {shown.length === 0 && <li className="muted">No matches</li>}
      </ul>
    </>
  )
}

export function SelectionDetails({ netlist, selection }: { netlist: Netlist; selection: Selection }) {
  if (selection?.kind === 'island') {
    const pins = netlist.components.flatMap((c) =>
      c.pins.filter((p) => p.net === selection.net).map((p) => `${c.ref}.${p.number}`),
    )
    return (
      <dl className="properties">
        <dt>Net</dt>
        <dd>{selection.net}</dd>
        <dt>Pins</dt>
        <dd>{pins.length ? pins.join(' ') : '–'}</dd>
      </dl>
    )
  }
  const component = selection?.kind === 'part' ? netlist.components.find((c) => c.ref === selection.ref) : undefined
  if (!component) {
    return (
      <p className="muted">
        Nothing selected.
        <br />
        Click a part or copper island on the canvas, or a row in the component list.
      </p>
    )
  }
  return (
    <>
      <dl className="properties">
        <dt>Ref</dt>
        <dd>{component.ref}</dd>
        <dt>Value</dt>
        <dd>{component.value || '–'}</dd>
        <dt>Footprint</dt>
        <dd className="footprint">{component.footprint || '–'}</dd>
      </dl>
      <table className="pin-table">
        <thead>
          <tr>
            <th>Pin</th>
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {component.pins.map((p) => (
            <tr key={p.number}>
              <td>{p.number}</td>
              <td>{p.net || '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

interface ValidationProps {
  components: number
  nets: number
  openPins: number
  shortedPins: number
  netsTooClose: number
  netsSplit: number
}

export function Validation(props: ValidationProps) {
  const errors = props.shortedPins + props.netsTooClose + props.netsSplit
  const warnings = props.openPins
  return (
    <>
      <div className="badges">
        {errors === 0 && warnings === 0 && <span className="badge ok">No errors</span>}
        {errors > 0 && <span className="badge error">{errors} {errors === 1 ? 'error' : 'errors'}</span>}
        {warnings > 0 && <span className="badge warn">{warnings} {warnings === 1 ? 'warning' : 'warnings'}</span>}
      </div>
      <dl className="properties counts">
        <dt>Components</dt>
        <dd>{props.components}</dd>
        <dt>Nets</dt>
        <dd>{props.nets}</dd>
        <dt>Open pins</dt>
        <dd className={props.openPins ? 'warn' : ''}>{props.openPins}</dd>
        <dt>Shorted pins</dt>
        <dd className={props.shortedPins ? 'error' : ''}>{props.shortedPins}</dd>
        <dt>Nets too close</dt>
        <dd className={props.netsTooClose ? 'error' : ''}>{props.netsTooClose}</dd>
        <dt title="Islands in separate pieces need a wire jumper">Nets split</dt>
        <dd className={props.netsSplit ? 'error' : ''}>{props.netsSplit}</dd>
      </dl>
    </>
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
    <dialog ref={dialogRef} className="ai-dialog" onClose={onClose}>
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
        <li>Keep this page open. The status bar shows <b>Agent connected</b> once the assistant runs.</li>
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
