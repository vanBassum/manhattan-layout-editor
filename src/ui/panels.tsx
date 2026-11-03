import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { refPrefix } from '../footprintTemplates'
import { labelSymbol } from '../schematic'
import { isToggleClick, selectedRefs, selectedWiring, toggleSelected } from '../selection'
import type { BuiltComponent, BuiltNetlist, LabelSymbol, Layout, NetLabel, Placement, Selection, Shape } from '../types'
import { Icon, type IconName } from './icons'
import type { LayerInfo, LayerView } from './layers'
import { useDropdown } from './useDropdown'

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
  const { open, setOpen, menuRef } = useDropdown()
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

// A row is only a guess for a footprint the editor does not recognise, so its label is the footprint itself.
const PACKAGE_LABELS: Record<Exclude<Shape, 'row'>, string> = {
  smd: 'SMD',
  to92: 'TO-92',
  to126: 'TO-126',
  trimmer: 'Trimmer',
  radial: 'Radial',
  axial: 'Axial',
  dip: 'DIP',
}

/** Short package description for the component list, e.g. "TO-92", "1206" or "Radial". */
function packageLabel(component: BuiltComponent): string {
  const { shape } = component.geometry
  if (shape === 'smd') return component.footprint.match(/(0201|0402|0603|0805|1206|1210|2512)/)?.[1] ?? PACKAGE_LABELS.smd
  if (shape === 'row') return component.footprint || '–'
  return PACKAGE_LABELS[shape]
}

function KindBadge({ partRef, large = false }: { partRef: string; large?: boolean }) {
  const prefix = refPrefix(partRef) || '?'
  return (
    <span className={`kind-badge${large ? ' large' : ''} kind-${prefix.charAt(0)}`} aria-hidden="true">
      {prefix}
    </span>
  )
}

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
                onClick={(e) => onSelect(isToggleClick(e) ? toggleSelected(selection, item) : item)}
                title={c.footprint || undefined}
              >
                <KindBadge partRef={c.ref} />
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
      <KindBadge partRef={component.ref} large />
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
