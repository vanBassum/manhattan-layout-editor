import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Layers } from './Canvas'
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
}

export type IconName = keyof typeof ICON_PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d={ICON_PATHS[name]} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <details className="section" open>
      <summary>{title}</summary>
      <div className="section-body">{children}</div>
    </details>
  )
}

const LAYER_LABELS: Record<keyof Layers, string> = {
  islands: 'Copper islands',
  parts: 'Components',
  netLabels: 'Net labels',
  leads: 'Leads / ratsnest',
  grid: 'Grid',
}

export function LayerToggles({ layers, onChange }: { layers: Layers; onChange: (layers: Layers) => void }) {
  return (
    <div className="layer-list">
      {(Object.keys(LAYER_LABELS) as (keyof Layers)[]).map((layer) => (
        <label key={layer} className="check-row">
          <input
            type="checkbox"
            checked={layers[layer]}
            onChange={(e) => onChange({ ...layers, [layer]: e.target.checked })}
          />
          {LAYER_LABELS[layer]}
        </label>
      ))}
    </div>
  )
}

interface ComponentListProps {
  netlist: Netlist
  selection: Selection
  onSelect: (selection: Selection) => void
}

export function ComponentList({ netlist, selection, onSelect }: ComponentListProps) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = netlist.components.filter((c) =>
    [c.ref, c.value, c.footprint].some((text) => text.toLowerCase().includes(needle)),
  )
  return (
    <>
      <label className="search">
        <Icon name="search" />
        <input type="search" placeholder="Search components" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <ul className="component-list">
        {shown.map((c) => (
          <li key={c.ref}>
            <button
              className={selection?.kind === 'part' && selection.ref === c.ref ? 'selected' : ''}
              onClick={() => onSelect({ kind: 'part', ref: c.ref })}
              title={c.footprint || undefined}
            >
              <span className="ref">{c.ref}</span>
              <span className="value">{c.value}</span>
              <span className="footprint">{c.footprint}</span>
            </button>
          </li>
        ))}
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
