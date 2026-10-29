import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LayerName, Layers, LayerView } from './Canvas'
import { componentGeometry, type ResistorChoice } from './layout'
import type { NetComponent, Netlist, Selection } from './types'

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
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6',
  eyeOff: 'M2 12s3.5-7 10-7c2 0 3.7.7 5.1 1.6 M22 12s-3.5 7-10 7c-2 0-3.7-.7-5.1-1.6 M3 3l18 18',
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

const LAYER_INFO: Record<LayerName, { label: string; swatch: string }> = {
  islands: { label: 'Copper islands', swatch: '#d9904f' },
  parts: { label: 'Components', swatch: '#4a4a4a' },
  netLabels: { label: 'Net labels', swatch: '#5a3b1c' },
  leads: { label: 'Leads / ratsnest', swatch: '#2f9e44' },
  grid: { label: 'Grid', swatch: '#c7cdd4' },
}

export function LayerToggles({ layers, onChange }: { layers: Layers; onChange: (layers: Layers) => void }) {
  const update = (layer: LayerName, change: Partial<LayerView>) => onChange({ ...layers, [layer]: { ...layers[layer], ...change } })
  return (
    <div className="layer-list">
      {(Object.keys(LAYER_INFO) as LayerName[]).map((layer) => {
        const { label, swatch } = LAYER_INFO[layer]
        const view = layers[layer]
        return (
          <div key={layer} className={view.visible ? 'layer-row' : 'layer-row hidden'}>
            <button
              className="icon-button eye"
              onClick={() => update(layer, { visible: !view.visible })}
              title={view.visible ? 'Hide layer' : 'Show layer'}
              aria-pressed={view.visible}
            >
              <Icon name={view.visible ? 'eye' : 'eyeOff'} />
            </button>
            <span className="swatch" style={{ background: swatch }} />
            <span className="layer-name">{label}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(view.opacity * 100)}
              disabled={!view.visible}
              onChange={(e) => update(layer, { opacity: Number(e.target.value) / 100 })}
              title={`Opacity ${Math.round(view.opacity * 100)}% (below 50% the layer ignores clicks)`}
              aria-label={`${label} opacity`}
            />
          </div>
        )
      })}
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
  /** Parts with open or shorted pins. */
  refsWithIssues: ReadonlySet<string>
}

/** Short package description for the component list, e.g. "TO-92", "1206" or "Radial". */
function packageLabel(component: NetComponent): string {
  const chip = component.footprint.match(/(0201|0402|0603|0805|1206|1210|2512)/)?.[1]
  switch (componentGeometry(component).shape) {
    case 'smd': return chip ?? 'SMD'
    case 'to92': return 'TO-92'
    case 'to126': return 'TO-126'
    case 'trimmer': return 'Trimmer'
    case 'radial': return 'Radial'
    case 'axial': return 'Axial'
    case 'dip': return 'DIP'
    default: return component.footprint || '–'
  }
}

const refPrefix = (ref: string) => ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? '?'

export function ComponentList(props: ComponentListProps) {
  const { netlist, selection, onSelect, convertible, convertedToSmd, onConvert, refsWithIssues } = props
  const [query, setQuery] = useState('')
  const [onlyIssues, setOnlyIssues] = useState(false)
  const [conversion, setConversion] = useState<Conversion | null>(null)
  const needle = query.trim().toLowerCase()
  const shown = netlist.components.filter(
    (c) =>
      (!onlyIssues || refsWithIssues.has(c.ref)) &&
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

  const targetLabel = conversion?.choice === '1206' ? '1206' : 'THT'

  return (
    <>
      <label className="search">
        <Icon name="search" />
        <input type="search" placeholder="Search components" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="list-tabs">
        <button className={onlyIssues ? '' : 'active'} onClick={() => setOnlyIssues(false)}>
          All ({netlist.components.length})
        </button>
        <button className={onlyIssues ? 'active' : ''} onClick={() => setOnlyIssues(true)} title="Parts with open or shorted pins">
          Issues ({refsWithIssues.size})
        </button>
        {convertible.size > 0 && !conversion && (
          <button className="convert-start" onClick={() => startConversion('1206')} title="Choose a footprint for the plain resistors">
            <Icon name="convert" />Convert
          </button>
        )}
      </div>
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
          if (conversion && convertible.has(c.ref)) {
            const checked = conversion.refs.has(c.ref)
            return (
              <li key={c.ref}>
                <label className={`component-row${checked ? ' checked' : ''}`} title={c.footprint || undefined}>
                  <input type="checkbox" checked={checked} onChange={() => toggleRef(c.ref)} />
                  <span className="ref">{c.ref}</span>
                  <span className="value">{c.value}</span>
                  <span className="package">{checked ? `→ ${targetLabel}` : packageLabel(c)}</span>
                </label>
              </li>
            )
          }
          const selected = selection?.kind === 'part' && selection.ref === c.ref
          const issue = refsWithIssues.has(c.ref)
          return (
            <li key={c.ref} className={conversion ? 'unaffected' : ''}>
              <button
                className={`component-row${selected ? ' selected' : ''}${issue ? ' issue' : ''}`}
                onClick={() => onSelect({ kind: 'part', ref: c.ref })}
                title={c.footprint || undefined}
              >
                <span className={`kind-badge kind-${refPrefix(c.ref).charAt(0)}`} aria-hidden="true">
                  {refPrefix(c.ref)}
                </span>
                <span className="ref">{c.ref}</span>
                <span className="value">{c.value}</span>
                <span className="package">{packageLabel(c)}</span>
              </button>
            </li>
          )
        })}
        {shown.length === 0 && <li className="muted">{onlyIssues ? 'No issues' : 'No matches'}</li>}
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
