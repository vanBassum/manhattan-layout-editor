import { useEffect, useRef, useState } from 'react'
import { BodyShape } from './Canvas'
import { FOOTPRINT_LIBRARY, type FootprintCategory, type LibraryFootprint } from './footprints'
import { boundsOf } from './geometry'
import { componentGeometry, defaultLeadEnds } from './layout'
import { Icon } from './panels'
import type { NetComponent, Netlist, Point, Rect } from './types'

/** A library footprint, or each part's own footprint from the netlist. */
type Choice = LibraryFootprint | 'netlist'

interface FootprintGroup {
  footprint: string
  parts: NetComponent[]
}

const CATEGORY_TABS: ('All' | FootprintCategory)[] = ['All', 'Resistors', 'Capacitors', 'Transistors', 'Diodes']
const COPPER = '#d9945a'
const LEAD_COLOR = '#777777'
const PAD_HEIGHT = 3
/** How far the outer pads reach beyond the outermost lead ends. */
const PAD_OVERHANG = 1.5

function groupByFootprint(components: NetComponent[]): FootprintGroup[] {
  const groups = new Map<string, NetComponent[]>()
  for (const c of components) {
    const parts = groups.get(c.footprint)
    if (parts) parts.push(c)
    else groups.set(c.footprint, [c])
  }
  return [...groups]
    .map(([footprint, parts]) => ({ footprint, parts }))
    .sort((a, b) => a.footprint.localeCompare(b.footprint))
}

const footprintName = (footprint: string) => footprint || '(no footprint)'
const mm = (v: number) => String(Math.round(v * 100) / 100)

function unavailableReason(footprint: LibraryFootprint, pinCounts: ReadonlySet<number>): string | undefined {
  if (pinCounts.size > 1) return 'Selection has mixed pin counts'
  const [count] = pinCounts
  if (count !== undefined && count !== footprint.pins) return `${footprint.pins} pins, selection has ${count}`
  return undefined
}

/**
 * One copper pad per lead, split by isolation gaps halfway between neighbouring lead ends.
 * Only for leads ending on one line (two-lead and in-line parts); a DIP gets no pads.
 */
function padsFor(ends: Point[], isolation: number): Rect[] {
  if (ends.some((e) => Math.abs(e.y - ends[0].y) > 1e-6)) return []
  const xs = ends.map((e) => e.x).sort((a, b) => a - b)
  return xs.map((x, k) => {
    const left = k === 0 ? x - PAD_OVERHANG : (xs[k - 1] + x) / 2 + isolation / 2
    const right = k === xs.length - 1 ? x + PAD_OVERHANG : (x + xs[k + 1]) / 2 - isolation / 2
    return { x: left, y: ends[0].y - PAD_HEIGHT / 2, w: right - left, h: PAD_HEIGHT }
  })
}

function drawingOf(component: NetComponent, isolation?: number) {
  const geometry = componentGeometry(component)
  const ends = defaultLeadEnds(geometry)
  const pads = isolation === undefined ? [] : padsFor(ends, isolation)
  const bounds = boundsOf([geometry.body, ...pads, ...ends.map((e) => ({ ...e, w: 0, h: 0 }))])!
  return { geometry, ends, pads, bounds }
}

interface FootprintDrawingProps {
  component: NetComponent
  /** Draws copper pads with this isolation gap between them. */
  isolation?: number
  /** Area to show, so drawings side by side share one scale; defaults to the drawing's own bounds. */
  frame?: Rect
  className: string
}

function FootprintDrawing({ component, isolation, frame, className }: FootprintDrawingProps) {
  const { geometry, ends, pads, bounds } = drawingOf(component, isolation)
  const view = frame ?? bounds
  const margin = 0.8
  return (
    <svg
      className={className}
      viewBox={`${view.x - margin} ${view.y - margin} ${view.w + 2 * margin} ${view.h + 2 * margin}`}
      aria-hidden="true"
    >
      {pads.map((r, k) => (
        <rect key={k} x={r.x} y={r.y} width={r.w} height={r.h} fill={COPPER} />
      ))}
      {geometry.anchors.map((a, k) => (
        <line key={k} x1={a.x} y1={a.y} x2={ends[k].x} y2={ends[k].y} stroke={LEAD_COLOR} strokeWidth={0.35} strokeLinecap="round" />
      ))}
      <BodyShape geometry={geometry} stroke="#111" strokeWidth={0.12} />
      {ends.map((e, k) => (
        <circle key={k} cx={e.x} cy={e.y} r={0.35} fill="#2f9e44" />
      ))}
    </svg>
  )
}

function sizeText(component: NetComponent): string {
  const { body } = componentGeometry(component)
  return `${mm(body.w)} × ${mm(body.h)} mm body, ${component.pins.length} pins`
}

/** Checkbox that also shows "some checked"; `indeterminate` only exists as a DOM property. */
function GroupCheckbox({ checked, mixed, onChange, label }: { checked: boolean; mixed: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      ref={(el) => {
        if (el) el.indeterminate = mixed
      }}
      checked={checked}
      onChange={onChange}
      aria-label={label}
    />
  )
}

interface FootprintDialogProps {
  /** Components as built, so each shows its current footprint. */
  built: Netlist
  /** Components as imported, for going back to the netlist footprint. */
  imported: Netlist
  initialRefs: string[]
  isolation: number
  onApply: (refs: ReadonlySet<string>, footprint: string | undefined) => void
  onClose: () => void
}

export function FootprintDialog({ built, imported, initialRefs, isolation, onApply, onClose }: FootprintDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])

  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(initialRefs))
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [category, setCategory] = useState<'All' | FootprintCategory>('All')
  const [query, setQuery] = useState('')
  const [choice, setChoice] = useState<Choice | null>(null)

  const groups = groupByFootprint(built.components)
  const checkedParts = groups.flatMap((g) => g.parts.filter((c) => checked.has(c.ref)))
  const checkedGroups = groups.filter((g) => g.parts.some((c) => checked.has(c.ref)))
  const pinCounts = new Set(checkedParts.map((c) => c.pins.length))
  const netlistFootprints = new Map(imported.components.map((c) => [c.ref, c.footprint]))

  const targetOf = (part: NetComponent, target: Choice) =>
    target === 'netlist' ? netlistFootprints.get(part.ref) ?? part.footprint : target.id
  // Going back to the netlist footprint always fits, whatever the pin counts.
  const choiceFits = choice === 'netlist' || (choice !== null && unavailableReason(choice, pinCounts) === undefined)
  const changing = choice && choiceFits ? checkedParts.filter((c) => targetOf(c, choice) !== c.footprint) : []

  const toggle = (refs: string[], on: boolean) => {
    const next = new Set(checked)
    for (const ref of refs) {
      if (on) next.add(ref)
      else next.delete(ref)
    }
    setChecked(next)
  }

  const toggleCollapsed = (footprint: string) => {
    const next = new Set(collapsed)
    if (next.has(footprint)) next.delete(footprint)
    else next.add(footprint)
    setCollapsed(next)
  }

  const needle = query.trim().toLowerCase()
  const shownFootprints = FOOTPRINT_LIBRARY.filter(
    (f) =>
      (category === 'All' || f.category === category) &&
      [f.id, f.label, f.description].some((text) => text.toLowerCase().includes(needle)),
  )

  const apply = () => {
    if (!choice || changing.length === 0) return
    onApply(new Set(changing.map((c) => c.ref)), choice === 'netlist' ? undefined : choice.id)
    dialogRef.current?.close()
  }

  const currentPart = checkedParts[0]
  const newPart = currentPart && choice ? { ...currentPart, footprint: targetOf(currentPart, choice) } : undefined
  // Both previews share one frame, so their sizes compare at a glance.
  const previewFrame = currentPart
    ? boundsOf([currentPart, newPart].flatMap((c) => (c ? [drawingOf(c, isolation).bounds] : [])))!
    : undefined

  return (
    <dialog ref={dialogRef} className="footprint-dialog" onClose={onClose}>
      <header>
        <div>
          <h2><Icon name="convert" />Change footprint</h2>
          <p className="muted">Select a new footprint for the selected component(s).</p>
        </div>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>

      <div className="footprint-columns">
        <section className="footprint-column">
          <h3>Components</h3>
          <ul className="footprint-groups">
            {groups.map((group) => {
              const refs = group.parts.map((c) => c.ref)
              const count = refs.filter((ref) => checked.has(ref)).length
              const open = !collapsed.has(group.footprint)
              const name = footprintName(group.footprint)
              return (
                <li key={group.footprint}>
                  <div className="group-row">
                    <button
                      className="collapse-toggle"
                      onClick={() => toggleCollapsed(group.footprint)}
                      aria-expanded={open}
                      aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
                    >
                      {open ? '▾' : '▸'}
                    </button>
                    <label title={group.footprint || undefined}>
                      <GroupCheckbox
                        checked={count === refs.length}
                        mixed={count > 0 && count < refs.length}
                        onChange={() => toggle(refs, count < refs.length)}
                        label={`All ${name}`}
                      />
                      <span className="group-name">{name}</span>
                      <span className="group-count">· {refs.length}</span>
                    </label>
                  </div>
                  {open && (
                    <ul>
                      {group.parts.map((c) => (
                        <li key={c.ref}>
                          <label className="part-row">
                            <input type="checkbox" checked={checked.has(c.ref)} onChange={() => toggle([c.ref], !checked.has(c.ref))} />
                            <span className="ref">{c.ref}</span>
                            <span className="value">{c.value}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="footprint-summary">{checkedParts.length} selected</p>
        </section>

        <section className="footprint-column">
          <h3>Choose new footprint</h3>
          <div className="list-tabs">
            {CATEGORY_TABS.map((tab) => (
              <button key={tab} className={category === tab ? 'active' : ''} onClick={() => setCategory(tab)}>
                {tab}
              </button>
            ))}
          </div>
          <label className="search">
            <Icon name="search" />
            <input type="search" placeholder="Search footprints" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {pinCounts.size > 1 && (
            <p className="badge warn footprint-warning">
              The checked parts have different pin counts ({[...pinCounts].sort((a, b) => a - b).join(', ')}). Check parts with the same pin count to choose a library footprint.
            </p>
          )}
          <div className="footprint-cards">
            <button
              className={`footprint-card${choice === 'netlist' ? ' chosen' : ''}`}
              onClick={() => setChoice('netlist')}
              aria-pressed={choice === 'netlist'}
            >
              <span className="card-preview original" aria-hidden="true">↺</span>
              <span className="card-label">Netlist footprint (original)</span>
              <span className="card-description">Each part goes back to the footprint from its netlist</span>
            </button>
            {shownFootprints.map((f) => {
              const reason = unavailableReason(f, pinCounts)
              const chosen = choice !== 'netlist' && choice?.id === f.id
              return (
                <button
                  key={f.id}
                  className={`footprint-card${chosen ? ' chosen' : ''}`}
                  onClick={() => setChoice(f)}
                  disabled={reason !== undefined}
                  aria-pressed={chosen}
                  title={f.id}
                >
                  <FootprintDrawing
                    className="card-preview"
                    component={{ ref: 'X1', value: '', footprint: f.id, pins: Array.from({ length: f.pins }, (_, k) => ({ number: String(k + 1), net: '' })) }}
                  />
                  <span className="card-label">{f.label}</span>
                  <span className="card-description">{reason ?? f.description}</span>
                </button>
              )
            })}
            {shownFootprints.length === 0 && <p className="muted">No matching footprints</p>}
          </div>
        </section>

        <section className="footprint-column">
          <h3>Preview</h3>
          {currentPart ? (
            <div className="footprint-preview">
              <figure>
                <figcaption>Current</figcaption>
                <FootprintDrawing className="preview-drawing" component={currentPart} isolation={isolation} frame={previewFrame} />
                <span className="preview-name">{footprintName(currentPart.footprint)}</span>
                <span className="muted">{sizeText(currentPart)}</span>
                {checkedGroups.length > 1 && (
                  <span className="muted">
                    and {checkedGroups.length - 1} other {checkedGroups.length === 2 ? 'footprint' : 'footprints'}
                  </span>
                )}
              </figure>
              <figure>
                <figcaption>New</figcaption>
                {newPart ? (
                  <>
                    <FootprintDrawing className="preview-drawing" component={newPart} isolation={isolation} frame={previewFrame} />
                    <span className="preview-name">{footprintName(newPart.footprint)}</span>
                    <span className="muted">{sizeText(newPart)}</span>
                  </>
                ) : (
                  <p className="muted">Choose a footprint</p>
                )}
              </figure>
            </div>
          ) : (
            <p className="muted">Check one or more components on the left.</p>
          )}
          <div className="footprint-info">
            <b>What will happen?</b>
            <ul>
              <li>The checked components get the new footprint.</li>
              <li>Nets and connections stay the same.</li>
              <li>Bent leads of the changed parts are reset.</li>
              <li>Footprints with a different pin count cannot be chosen.</li>
            </ul>
          </div>
        </section>
      </div>

      <footer>
        <button onClick={() => dialogRef.current?.close()}>Cancel</button>
        <button className="primary" onClick={apply} disabled={changing.length === 0}>
          Apply to {changing.length} {changing.length === 1 ? 'component' : 'components'}
        </button>
      </footer>
    </dialog>
  )
}
