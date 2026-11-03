import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { LayerName, LayerView } from './Canvas'
import type { SchematicLayer } from './SchematicView'
import { labelSymbol } from './schematic'
import { selectedRefs, selectedWiring, toggleSelected } from './selection'
import type { BuiltComponent, BuiltNetlist, LabelSymbol, Layout, NetLabel, Placement, Selection } from './types'

const ICON_PATHS = {
  app: 'M4 4h6v6H4z M14 14h6v6h-6z M10 7h4v10 M7 10v7h7',
  chevronDown: 'M7 10l5 5 5-5',
  chevronRight: 'M10 7l5 5-5 5',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  newFile: 'M6 3h8l4 4v14H6z M14 3v4h4 M12 10v7 M8.5 13.5h7',
  folder: 'M3 6h6l2 2h10v11H3z',
  computer: 'M3 4h18v12H3z M8 20h8 M12 16v4',
  settings: 'M12 9a3 3 0 1 1 0 6a3 3 0 1 1 0-6 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1l2.1-2.1 M17 7l2.1-2.1',
  user: 'M12 4a4 4 0 1 1 0 8a4 4 0 1 1 0-8 M4 21c0-4 3.6-6 8-6s8 2 8 6',
  importExport: 'M4 8h13l-3-3 M20 16H7l3 3',
  clock: 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18 M12 7v5l3 2',
  open: 'M3 7h6l2 2h10v10H3z M3 7V5h6',
  save: 'M5 4h11l3 3v13H5z M8 4v5h7V4 M8 20v-6h8v6',
  sample: 'M4 6h16v12H4z M8 10h8 M8 14h5',
  grid: 'M4 4h16v16H4z M4 12h16 M12 4v16',
  export: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
  fit: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v4h-4',
  flipHorizontal: 'M12 3v18 M9 7L3 17h6z M15 7l6 10h-6z',
  flipVertical: 'M3 12h18 M7 9L17 3v6z M7 15l10 6v-6z',
  leads: 'M4 12h5 M15 12h5 M9 8h6v8H9z',
  select: 'M6 3l13 8-6 1.5L10 19z',
  pan: 'M12 3v18 M3 12h18 M9 6l3-3 3 3 M9 18l3 3 3-3 M6 9l-3 3 3 3 M18 9l3 3-3 3',
  moveBody: 'M9 9h6v6H9z M3 12h2 M19 12h2 M5 10v4 M19 10v4',
  optimize: 'M13 3L5 14h6l-1 7 8-11h-6z',
  search: 'M10 4a6 6 0 1 1 0 12a6 6 0 1 1 0-12 M15 15l5 5',
  convert: 'M4 8h14l-3-3 M20 16H6l3 3',
  plus: 'M12 5v14 M5 12h14',
  cloud: 'M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  schematic: 'M2 12h4 M6 9h8v6H6z M14 12h4 M18 7v10 M20 9v6',
  split: 'M3 5h18v14H3z M12 5v14',
  wire: 'M4 18h6V6h10 M4 18a1.5 1.5 0 1 0 0.01 0 M20 6a1.5 1.5 0 1 0 0.01 0',
  label: 'M4 7h11l5 5-5 5H4z M8 12h.01',
  sun: 'M12 8a4 4 0 1 1 0 8a4 4 0 1 1 0-8 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
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

interface RailMenuProps {
  icon: IconName
  label: string
  title: string
  children: ReactNode
}

/** A rail button that opens the pane's options below it; a click outside closes them. */
export function RailMenu({ icon, label, title, children }: RailMenuProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])
  return (
    <div className="menu" ref={menuRef}>
      <button
        className={open ? 'rail-button active' : 'rail-button'}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={title}
      >
        <Icon name={icon} />{label}
      </button>
      {open && <div className="menu-list view-menu">{children}</div>}
    </div>
  )
}

export const GRID_LINES_PER_MAJOR_OPTIONS = [2, 4, 5, 6, 8, 10]

export function GridSettings({ linesPerMajor, onChange }: { linesPerMajor: number; onChange: (linesPerMajor: number) => void }) {
  return (
    <div className="settings">
      <label title="How many fine grid steps lie between two solid grid lines">
        Solid line every
        <select value={linesPerMajor} onChange={(e) => onChange(Number(e.target.value))}>
          {GRID_LINES_PER_MAJOR_OPTIONS.map((n) => (
            <option key={n} value={n}>{n} steps</option>
          ))}
        </select>
      </label>
    </div>
  )
}

type LayerInfo<Name extends string> = Record<Name, { label: string; swatch: string }>

export const PCB_LAYERS: LayerInfo<LayerName> = {
  islands: { label: 'Copper islands', swatch: '#d9904f' },
  parts: { label: 'Components', swatch: '#4a4a4a' },
  references: { label: 'References', swatch: '#333333' },
  values: { label: 'Values', swatch: '#777777' },
  netLabels: { label: 'Net labels', swatch: '#5a3b1c' },
  leads: { label: 'Leads / ratsnest', swatch: '#2f9e44' },
  grid: { label: 'Grid', swatch: '#c7cdd4' },
}

export const SCHEMATIC_LAYERS: LayerInfo<SchematicLayer> = {
  references: { label: 'References', swatch: '#333333' },
  values: { label: 'Values', swatch: '#777777' },
  pinNumbers: { label: 'Pin numbers', swatch: '#aaaaaa' },
  netNames: { label: 'Net names', swatch: '#2a7fff' },
  grid: { label: 'Grid', swatch: '#c7cdd4' },
}

interface LayerTogglesProps<Name extends string> {
  /** The layers in the order they are listed. */
  info: LayerInfo<Name>
  layers: Record<Name, LayerView>
  onChange: (layers: Record<Name, LayerView>) => void
  /** Added to the opacity tooltip, e.g. what a faint layer does differently. */
  opacityNote?: string
}

export function LayerToggles<Name extends string>({ info, layers, onChange, opacityNote = '' }: LayerTogglesProps<Name>) {
  const update = (layer: Name, change: Partial<LayerView>) => onChange({ ...layers, [layer]: { ...layers[layer], ...change } })
  return (
    <div className="layer-list">
      {(Object.keys(info) as Name[]).map((layer) => {
        const { label, swatch } = info[layer]
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
              title={`Opacity ${Math.round(view.opacity * 100)}%${opacityNote}`}
              aria-label={`${label} opacity`}
            />
          </div>
        )
      })}
    </div>
  )
}

interface ComponentListProps {
  netlist: BuiltNetlist
  selection: Selection
  onSelect: (selection: Selection) => void
  /** With the PCB on screen the list marks parts with pin problems and has a footprint button. */
  pcb?: {
    onChangeFootprint: () => void
    /** Parts with open or shorted pins. */
    refsWithIssues: ReadonlySet<string>
  }
}

const NO_ISSUES: ReadonlySet<string> = new Set()

/** Short package description for the component list, e.g. "TO-92", "1206" or "Radial". */
function packageLabel(component: BuiltComponent): string {
  const chip = component.footprint.match(/(0201|0402|0603|0805|1206|1210|2512)/)?.[1]
  switch (component.geometry.shape) {
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
  const { netlist, selection, onSelect, pcb } = props
  const refsWithIssues = pcb?.refsWithIssues ?? NO_ISSUES
  const highlighted = new Set(selectedRefs(selection))
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = netlist.components.filter((c) => [c.ref, c.value, c.footprint].some((text) => text.toLowerCase().includes(needle)))

  return (
    <>
      <div className="search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search components"
          aria-label="Search components"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {pcb && (
          <button
            className="icon-button"
            onClick={pcb.onChangeFootprint}
            disabled={netlist.components.length === 0}
            title="Change footprints…"
            aria-label="Change footprints"
          >
            <Icon name="convert" />
          </button>
        )}
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
        {shown.length === 0 && <li className="muted">No matches</li>}
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

/** Text input that commits on Enter or blur, like NumberField. */
function TextField({ value, label, placeholder, onCommit }: { value: string; label: string; placeholder: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim())
  }

  return (
    <input
      type="text"
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

function MultiSelection({ refs, nets }: { refs: string[]; nets: string[] }) {
  return (
    <dl className="properties">
      <dt>Selected</dt>
      <dd>{refs.length} parts, {nets.length} islands</dd>
      <dt>Parts</dt>
      <dd>{refs.length ? refs.join(' ') : '–'}</dd>
      <dt>Nets</dt>
      <dd>{nets.length ? nets.join(' ') : '–'}</dd>
    </dl>
  )
}

function PartCard({ component }: { component: BuiltComponent }) {
  return (
    <div className="selection-card">
      <span className={`kind-badge large kind-${refPrefix(component.ref).charAt(0)}`} aria-hidden="true">
        {refPrefix(component.ref)}
      </span>
      <div>
        <div className="selection-title">{component.ref}</div>
        <div className="muted">{[component.value, packageLabel(component)].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

interface PartPropertiesProps {
  /** With the schematic's nets. */
  netlist: BuiltNetlist
  /** The schematic's labels, which a selection names by index. */
  labels: NetLabel[]
  selection: Selection
  onValueChange: (ref: string, value: string) => void
  onLabelChange: (index: number, changes: Partial<NetLabel>) => void
}

const LABEL_SYMBOLS: { value: LabelSymbol; label: string }[] = [
  { value: 'net', label: 'Net name' },
  { value: 'ground', label: 'Ground symbol' },
  { value: 'power', label: 'Power symbol' },
  { value: 'terminal', label: 'Terminal (connection point)' },
]

/** A lone selected label: its net name, and whether it is drawn as a name or as a ground, power or terminal symbol. */
function LabelProperties({ label, onChange }: { label: NetLabel; onChange: (changes: Partial<NetLabel>) => void }) {
  return (
    <div className="field-list">
      <span className="field-label">Net</span>
      <TextField value={label.name} label="Net" placeholder="e.g. VCC or GND" onCommit={(name) => name && onChange({ name, symbol: labelSymbol(label) })} />
      <span className="field-label">Drawn as</span>
      <select value={labelSymbol(label)} onChange={(e) => onChange({ symbol: e.target.value as LabelSymbol })}>
        {LABEL_SYMBOLS.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
    </div>
  )
}

/** The schematic side of the selection: what the part is and how the schematic connects it. */
export function PartProperties({ netlist, labels, selection, onValueChange, onLabelChange }: PartPropertiesProps) {
  const wiring = selectedWiring(selection)
  const loneLabel = selectedRefs(selection).length === 0 && wiring.wires.length === 0 && wiring.points.length === 0 && wiring.labels.length === 1
  if (loneLabel && labels[wiring.labels[0]]) {
    const index = wiring.labels[0]
    return <LabelProperties label={labels[index]} onChange={(changes) => onLabelChange(index, changes)} />
  }
  if (selection?.kind === 'multi') return <MultiSelection refs={selection.refs} nets={selection.nets} />
  const component = selection?.kind === 'part' ? netlist.components.find((c) => c.ref === selection.ref) : undefined
  if (!component) return <p className="muted">Nothing selected. Click a part in the schematic or the list.</p>
  return (
    <>
      <PartCard component={component} />
      <div className="field-list">
        <span className="field-label">Value</span>
        <TextField
          value={component.value}
          label="Value"
          placeholder="e.g. 10k or BD140"
          onCommit={(value) => onValueChange(component.ref, value)}
        />
      </div>
    </>
  )
}

interface SchematicCheckProps {
  shorts: string[][]
  /** Pins the schematic connects to nothing. */
  openPins: string[]
  /** Pins connected to other pins in the schematic than on the PCB. */
  pinsNotInPcb: string[]
  onUpdatePcb: () => void
}

/** Electrical rule check of the schematic, and whether the PCB still matches it. */
export function SchematicCheck({ shorts, openPins, pinsNotInPcb, onUpdatePcb }: SchematicCheckProps) {
  return (
    <>
      <div className="badges">
        {shorts.length === 0 && openPins.length === 0 && <span className="badge ok">No errors</span>}
        {shorts.length > 0 && <span className="badge error">{shorts.length} {shorts.length === 1 ? 'short' : 'shorts'}</span>}
        {openPins.length > 0 && <span className="badge warn">{openPins.length} open {openPins.length === 1 ? 'pin' : 'pins'}</span>}
      </div>
      <ul className="check-list">
        {shorts.map((names) => (
          <li key={names.join('+')} className="error">Shorted: {names.join(' + ')}</li>
        ))}
        {openPins.length > 0 && <li className="warn">Not connected: {openPins.join(' ')}</li>}
        <li className={pinsNotInPcb.length ? 'warn' : 'ok'}>
          {pinsNotInPcb.length ? `PCB is behind: ${pinsNotInPcb.length} pins connected differently` : 'PCB matches the schematic'}
        </li>
      </ul>
      {pinsNotInPcb.length > 0 && (
        <button className="update-pcb" onClick={onUpdatePcb} title="Give the PCB the schematic's nets (can be undone)">
          <Icon name="convert" />Update PCB
        </button>
      )}
    </>
  )
}

interface SelectionDetailsProps {
  netlist: BuiltNetlist
  layout: Layout
  selection: Selection
  onPlacementChange: (ref: string, changes: Partial<Pick<Placement, 'x' | 'y' | 'rotation'>>) => void
  onChangeFootprint: () => void
}

/** The PCB side of the selection: footprint and placement of a part, or a copper island. */
export function SelectionDetails({ netlist, layout, selection, onPlacementChange, onChangeFootprint }: SelectionDetailsProps) {
  if (selection?.kind === 'multi') return <MultiSelection refs={selection.refs} nets={selection.nets} />
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
      <PartCard component={component} />
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
  ['Drag a cut', 'Move it; both sides follow'],
  ['Drag an island edge', 'Move that edge of the selected island'],
  ['+ on a hovered edge', 'Grow the selected island 2.5 mm on that side'],
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
    <dialog ref={dialogRef} className="ai-dialog question-dialog" onCancel={() => onAnswer(question.cancel)}>
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

/** A submenu of the main menu. It opens on hover, or on a click (keyboard, touch), which must not close the menu. */
export function MenuGroup({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="submenu">
      <button aria-haspopup="menu" onClick={(e) => e.stopPropagation()}>
        <Icon name={icon} />
        {label}
        <Icon name="chevronRight" />
      </button>
      <div className="menu-list submenu-list" role="menu">
        {children}
      </div>
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
