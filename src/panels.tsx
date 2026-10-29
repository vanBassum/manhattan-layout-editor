import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LayerName, Layers, LayerView } from './Canvas'
import { componentGeometry } from './layout'
import { selectedRefs, toggleSelected } from './selection'
import type { Layout, NetComponent, Netlist, Placement, Selection } from './types'

const ICON_PATHS = {
  app: 'M4 4h6v6H4z M14 14h6v6h-6z M10 7h4v10 M7 10v7h7',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'M15 14l5-5-5-5 M20 9H9a5 5 0 0 0 0 10h3',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  open: 'M3 7h6l2 2h10v10H3z M3 7V5h6',
  save: 'M5 4h11l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6',
  sample: 'M4 6h16v12H4z M8 10h8 M8 14h5',
  grid: 'M4 4h16v16H4z M4 12h16 M12 4v16',
  export: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  fit: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v4h-4',
  leads: 'M4 12h5 M15 12h5 M9 8h6v8H9z',
  addRect: 'M4 6h12v12H4z M19 9v6 M16 12h6',
  removeRect: 'M4 6h12v12H4z M16 12h6',
  select: 'M6 3l13 8-6 1.5L10 19z',
  pan: 'M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3',
  moveBody: 'M9 9h6v6H9z M3 12h2 M19 12h2 M5 10v4 M19 10v4',
  optimize: 'M13 3L5 14h6l-1 7 8-11h-6z',
  search: 'M10 4a6 6 0 1 1 0 12a6 6 0 1 1 0-12 M15 15l5 5',
  convert: 'M4 8h14l-3-3 M20 16H6l3 3',
  plus: 'M12 5v14 M5 12h14',
  help: 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18 M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6 M12 17.5v.01',
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

interface ComponentListProps {
  netlist: Netlist
  selection: Selection
  onSelect: (selection: Selection) => void
  onChangeFootprint: () => void
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
  const { netlist, selection, onSelect, onChangeFootprint, refsWithIssues } = props
  const highlighted = new Set(selectedRefs(selection))
  const [query, setQuery] = useState('')
  const [onlyIssues, setOnlyIssues] = useState(false)
  const needle = query.trim().toLowerCase()
  const shown = netlist.components.filter(
    (c) =>
      (!onlyIssues || refsWithIssues.has(c.ref)) &&
      [c.ref, c.value, c.footprint].some((text) => text.toLowerCase().includes(needle)),
  )

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
        <button
          className="change-footprint"
          onClick={onChangeFootprint}
          disabled={netlist.components.length === 0}
          title="Choose another footprint for groups of parts"
        >
          <Icon name="convert" />Change footprint…
        </button>
      </div>
      <ul className="component-list">
        {shown.map((c) => {
          const selected = highlighted.has(c.ref)
          const issue = refsWithIssues.has(c.ref)
          const item = { kind: 'part', ref: c.ref } as const
          return (
            <li key={c.ref}>
              <button
                className={`component-row${selected ? ' selected' : ''}${issue ? ' issue' : ''}`}
                onClick={(e) => onSelect(e.shiftKey || e.ctrlKey || e.metaKey ? toggleSelected(selection, item) : item)}
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

interface NumberFieldProps {
  value: number
  unit: string
  step: number
  label: string
  onCommit: (value: number) => void
}

/** Number input that commits on Enter or blur, so typing a value is one undo step, not one per keystroke. */
function NumberField({ value, unit, step, label, onCommit }: NumberFieldProps) {
  const shown = String(Number(value.toFixed(2)))
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])

  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) setDraft(shown)
    else if (parsed !== Number(shown)) onCommit(parsed)
  }

  return (
    <span className="unit-input">
      <input
        type="number"
        step={step}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setDraft(shown)
        }}
      />
      {unit}
    </span>
  )
}

interface SelectionDetailsProps {
  netlist: Netlist
  layout: Layout
  selection: Selection
  onPlacementChange: (ref: string, changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) => void
  onChangeFootprint: () => void
}

export function SelectionDetails({ netlist, layout, selection, onPlacementChange, onChangeFootprint }: SelectionDetailsProps) {
  if (selection?.kind === 'multi') {
    return (
      <dl className="properties">
        <dt>Selected</dt>
        <dd>{selection.refs.length} parts, {selection.nets.length} islands</dd>
        <dt>Parts</dt>
        <dd>{selection.refs.length ? selection.refs.join(' ') : '–'}</dd>
        <dt>Nets</dt>
        <dd>{selection.nets.length ? selection.nets.join(' ') : '–'}</dd>
      </dl>
    )
  }
  if (selection?.kind === 'island') {
    const pins = netlist.components.flatMap((c) =>
      c.pins.filter((p) => p.net === selection.net).map((p) => `${c.ref}.${p.number}`),
    )
    const island = layout.islands.find((i) => i.net === selection.net)
    const rect = island?.rects[selection.rectIndex]
    return (
      <>
        <div className="selection-card">
          <span className="selection-thumb island" aria-hidden="true" />
          <div>
            <div className="selection-title">{selection.net}</div>
            <div className="muted">
              {island?.plane ? 'Ground plane' : 'Copper island'} · {island?.rects.length ?? 0} rect
              {island?.rects.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>
        <dl className="properties">
          {rect && (
            <>
              <dt>Rect</dt>
              <dd>{rect.w.toFixed(1)} × {rect.h.toFixed(1)} mm at ({rect.x.toFixed(1)}, {rect.y.toFixed(1)})</dd>
            </>
          )}
          <dt>Pins</dt>
          <dd>{pins.length ? pins.join(' ') : '–'}</dd>
        </dl>
      </>
    )
  }
  const component = selection?.kind === 'part' ? netlist.components.find((c) => c.ref === selection.ref) : undefined
  const placement = component && layout.placements.find((p) => p.ref === component.ref)
  if (!component || !placement) {
    return (
      <p className="muted">
        Nothing selected.
        <br />
        Click a part or copper island on the canvas, or a row in the component list.
      </p>
    )
  }
  const change = (changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) => onPlacementChange(component.ref, changes)
  return (
    <>
      <div className="selection-card">
        <span className={`kind-badge large kind-${refPrefix(component.ref).charAt(0)}`} aria-hidden="true">
          {refPrefix(component.ref)}
        </span>
        <div>
          <div className="selection-title">{component.ref}</div>
          <div className="muted">{[component.value, packageLabel(component)].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <div className="field-list">
        <span className="field-label">Footprint</span>
        <div className="footprint-field">
          <span title={component.footprint}>{component.footprint || '–'}</span>
          <button className="icon-button" onClick={onChangeFootprint} title="Change footprint…" aria-label="Change footprint">
            <Icon name="search" />
          </button>
        </div>
        <span className="field-label">Position</span>
        <div className="field-pair">
          <span className="axis">X</span>
          <NumberField label="X" value={placement.x} unit="mm" step={0.5} onCommit={(x) => change({ x })} />
          <span className="axis">Y</span>
          <NumberField label="Y" value={placement.y} unit="mm" step={0.5} onCommit={(y) => change({ y })} />
        </div>
        <span className="field-label">Rotation</span>
        <NumberField label="Rotation" value={placement.rotation} unit="°" step={15} onCommit={(r) => change({ rotation: ((r % 360) + 360) % 360 })} />
      </div>
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

const SHORTCUTS: [string, string][] = [
  ['V / H', 'Select / pan tool'],
  ['Click, Shift+click', 'Select, add to selection'],
  ['Drag empty space', 'Marquee select (Shift adds)'],
  ['Ctrl+A', 'Select all'],
  ['M', 'Anchor leads on/off: dragging a part leaves its lead ends in place'],
  ['Shift+drag part', 'Take the leads along while anchored'],
  ['Drag a lead end', 'Bend the lead'],
  ['Space / Shift+Space', 'Rotate 90° / 15°'],
  ['Del', 'Remove the selected rectangle'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Middle-drag, wheel', 'Pan, zoom'],
  ['F', 'Fit the board in view'],
]

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])

  return (
    <dialog ref={dialogRef} className="ai-dialog" onClose={onClose}>
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
        <li>Keep this page open. The AI button gets a green dot once the assistant runs.</li>
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
