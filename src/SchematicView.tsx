import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, inflate, rectBetween, rectsOverlap, rotatePoint, snapToGrid } from './geometry'
import {
  CELL_HEIGHT,
  CELL_WIDTH,
  isConnection,
  pinEnds,
  pointKey,
  polylineWires,
  route,
  SCHEMATIC_GRID,
  withPlacementChanges,
  withWireEndMoved,
  withWireShifted,
  type FullSchematic,
  type SchematicNets,
} from './schematic'
import { componentSymbol } from './definitions'
import type { PinEnd } from './schematic'
import type { SymbolGraphic } from './types'
import { addToSelection, isToggleClick, selectedRefs, selectionOf, toggleSelected } from './selection'
import type { NetComponent, NetLabel, Netlist, Point, Rect, SchematicPlacement, Selection } from './types'
import { gridPitch, useViewport, ViewportGrid, type View } from './viewport'

/**
 * Select: drag parts; drag from a pin end to draw a wire; drag a wire end to move it, or a wire
 * sideways to shift it. Wire: drag for one wire, or click corner by corner. Label: click to name a point.
 */
export type SchematicTool = 'select' | 'wire' | 'label'

/** Schematic grid pitches in mm: 0.1 inch and up; every fifth line is solid. Pins sit on the finest one. */
const GRID_PITCHES_MM = [SCHEMATIC_GRID, 12.7, 63.5, 317.5]

/** A press that moves less than this (screen pixels) is a click, not a drag. */
const CLICK_TOLERANCE_PX = 3
/** How close (screen pixels) the pointer must be to grab a pin end or wire end. */
const GRAB_RADIUS_PX = 8

/**
 * The wire being drawn, whatever started it: the corners placed so far, where the pointer is, and
 * which way the next leg bends first (null until the pointer first moves, which decides it).
 */
interface WireDraft {
  points: Point[]
  cursor: Point
  horizontalFirst: boolean | null
}

const draftPath = (draft: WireDraft) => {
  const last = draft.points[draft.points.length - 1]
  return [...draft.points, ...route(last, draft.cursor, draft.horizontalFirst ?? true).slice(1)]
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: Point; startX: number; startY: number; additive: boolean }
  /**
   * The pressed part, or the whole selection when it is part of one. Moves are applied to `base`,
   * the schematic at the start: only what was on the pins then goes along. A press that ends
   * without moving selects `pressed` alone, or with `toggle` set, toggles it in the selection.
   */
  | {
      kind: 'parts'
      pressed: string
      toggle: boolean
      start: Point
      origins: SchematicPlacement[]
      base: FullSchematic
      moved: boolean
    }
  /** A press that starts or continues a wire draft: dragging finishes it on release, a click keeps drawing. */
  | { kind: 'draw'; startX: number; startY: number; moved: boolean }
  | { kind: 'wire-end'; index: number; end: 1 | 2; startX: number; startY: number; base: FullSchematic; moved: boolean }
  | { kind: 'wire-shift'; index: number; start: Point; base: FullSchematic; moved: boolean }

type Item = { kind: 'wire'; index: number } | { kind: 'label'; index: number }

/** A pin end or wire end under the pointer. */
interface Grab {
  point: Point
  onPin: boolean
  wireEnd?: { index: number; end: 1 | 2 }
}

const snapPoint = (p: Point): Point => ({ x: snapToGrid(p.x, SCHEMATIC_GRID), y: snapToGrid(p.y, SCHEMATIC_GRID) })

/** Where a part can be grabbed, and what a selection rectangle must touch: its pin ends with some margin. */
function partArea(pins: PinEnd[]): Rect | null {
  const bounds = boundsOf(pins.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))
  return bounds && inflate(bounds, 2)
}

const isGround = (name: string) => /^(GND|AGND|DGND|PGND|VSS|0)$/i.test(name)
const isSupply = (name: string) => /^(V\+|V-|VCC|VDD|VEE|[+-]?\d+(\.\d+)?V)$/i.test(name)

interface LabelProps {
  label: NetLabel
  /** Direction of the pin the label sits on, so the text points away from the part. */
  direction: Point
  className: string
  onPointerDown: (e: ReactPointerEvent) => void
  onDoubleClick: () => void
}

/** Ground as the thick bar from the reference drawings; any other net as its name. */
function LabelMark({ label, direction, className, onPointerDown, onDoubleClick }: LabelProps) {
  const { x, y, name } = label
  if (isGround(name)) {
    const stubEnd = y + 2.54
    return (
      <g className={className} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        <title>{name}</title>
        <rect className="sch-hit" x={x - 1.6} y={y} width={3.2} height={3.4} />
        <polyline className="sch-line" points={`${x},${y} ${x},${stubEnd}`} />
        <rect className="sch-fill" x={x - 1.52} y={stubEnd} width={3.04} height={0.6} />
      </g>
    )
  }
  if (isSupply(name)) {
    // A supply port as in the reference drawing: a stub up to a bar, the name above it.
    const barY = y - 2.54
    return (
      <g className={className} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        <rect className="sch-hit" x={x - 1.8} y={barY - 2} width={3.6} height={4.6} />
        <polyline className="sch-line" points={`${x},${y} ${x},${barY}`} />
        <rect className="sch-fill" x={x - 1.52} y={barY - 0.3} width={3.04} height={0.6} />
        <text className="sch-net" x={x} y={barY - 0.9} textAnchor="middle">
          {name}
        </text>
      </g>
    )
  }
  const horizontal = direction.x !== 0
  const textX = x + direction.x * 0.6
  const textY = horizontal ? y + 0.45 : y + direction.y * 1.2 + (direction.y > 0 ? 0.9 : 0)
  const anchor = horizontal ? (direction.x > 0 ? 'start' : 'end') : 'middle'
  return (
    <g className={className} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <circle className="sch-label-dot" cx={x} cy={y} r={0.35} />
      <text className="sch-net" x={textX} y={textY} textAnchor={anchor}>
        {name}
      </text>
    </g>
  )
}

const FILL_CLASS = {
  solid: 'sch-fill',
  body: 'sch-resistor',
  power: 'sch-resistor power',
  open: 'sch-plate-open',
  box: 'sch-box',
  none: 'sch-outline',
} as const
const pointList = (points: [number, number][]) => points.map((p) => p.join(',')).join(' ')

/** One drawing element of a symbol definition. */
function SymbolShape({ graphic }: { graphic: SymbolGraphic }) {
  switch (graphic.type) {
    case 'line':
      return <polyline className="sch-line" points={pointList(graphic.points)} />
    case 'polygon':
      return <polygon className={FILL_CLASS[graphic.fill]} points={pointList(graphic.points)} />
    case 'rect':
      return <rect className={FILL_CLASS[graphic.fill]} x={graphic.x} y={graphic.y} width={graphic.w} height={graphic.h} />
    case 'circle':
      return <circle className={FILL_CLASS[graphic.fill]} cx={graphic.x} cy={graphic.y} r={graphic.r} />
    case 'text':
      return (
        <text className={graphic.style === 'mark' ? 'sch-pin-mark' : 'sch-pin-number'} x={graphic.x} y={graphic.y} textAnchor={graphic.anchor}>
          {graphic.text}
        </text>
      )
  }
}

interface PartProps {
  component: NetComponent
  placement: SchematicPlacement
  pins: PinEnd[]
  selected: boolean
  onPointerDown: (e: ReactPointerEvent) => void
}

/** The body rotates with the part; reference and value stay upright. Unconnected pins get an open circle. */
function SchematicPart({ component, placement, pins, selected, onPointerDown }: PartProps) {
  const symbol = componentSymbol(component)
  const { x, y, rotation } = placement
  const hitArea = partArea(pins)
  const labelOffset = rotatePoint(symbol.label, rotation)
  const label = { x: x + labelOffset.x, y: y + labelOffset.y }
  return (
    <g className={selected ? 'sch-part selected' : 'sch-part'} onPointerDown={onPointerDown}>
      <title>{`${component.ref} ${component.value}`}</title>
      {hitArea && <rect className="sch-hit" x={hitArea.x} y={hitArea.y} width={hitArea.w} height={hitArea.h} />}
      <g transform={`translate(${x} ${y}) rotate(${rotation})`}>
        {symbol.graphics.map((graphic, k) => (
          <SymbolShape key={k} graphic={graphic} />
        ))}
      </g>
      <text className="sch-ref" x={label.x} y={label.y}>{component.ref}</text>
      <text className="sch-value" x={label.x} y={label.y + 1.5}>{component.value}</text>
      {pins.map((pin, k) => !component.pins[k]?.net && <circle key={k} className="sch-open-pin" cx={pin.x} cy={pin.y} r={0.5} />)}
    </g>
  )
}

interface Props {
  /** As built, with the nets the schematic gives. */
  netlist: Netlist
  schematic: FullSchematic
  nets: SchematicNets
  onChange: (next: FullSchematic) => void
  /** Called once per edit, just before its first change, so it can be undone as a whole. */
  onBeginEdit: () => void
  selection: Selection
  onSelect: (selection: Selection) => void
  tool: SchematicTool
  fitRequest: number
}

export function SchematicView({ netlist, schematic, nets, onChange, onBeginEdit, selection, onSelect, tool, fitRequest }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [item, setItem] = useState<Item | null>(null)
  const [draft, setDraft] = useState<WireDraft | null>(null)
  const [overPoint, setOverPoint] = useState(false)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const { view, setView, size, fitTo } = useViewport(svgRef)
  const highlightedRefs = new Set(selectedRefs(selection))

  const componentsByRef = new Map(netlist.components.map((c) => [c.ref, c]))
  const parts = schematic.placements.flatMap((placement) => {
    const component = componentsByRef.get(placement.ref)
    return component ? [{ component, placement, pins: pinEnds(component, placement) }] : []
  })
  const pinKeys = new Set(parts.flatMap(({ pins }) => pins.map(pointKey)))

  useEffect(() => {
    const cells = schematic.placements.map((p) => ({ x: p.x - CELL_WIDTH / 2, y: p.y - CELL_HEIGHT / 2, w: CELL_WIDTH, h: CELL_HEIGHT }))
    const bounds = boundsOf(cells)
    if (bounds) fitTo(inflate(bounds, 5))
    // Only refit when explicitly requested, not on every edit.
  }, [fitRequest])

  // Dropping a part selection also drops a wire or label selection, and the other way round.
  useEffect(() => {
    if (selection) setItem(null)
  }, [selection])

  // A draft belongs to the tool it was started in.
  useEffect(() => setDraft(null), [tool])

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale }
  }

  /** The nearest pin end or wire end within grabbing distance; a pin wins over a wire end on the same spot. */
  const grabAt = (p: Point): Grab | null => {
    const radius = GRAB_RADIUS_PX / view.scale
    const candidates: Grab[] = [
      ...parts.flatMap(({ pins }) => pins.map((pin) => ({ point: { x: pin.x, y: pin.y }, onPin: true }))),
      ...schematic.wires.flatMap((w, index) => [
        { point: { x: w.x1, y: w.y1 }, onPin: pinKeys.has(pointKey({ x: w.x1, y: w.y1 })), wireEnd: { index, end: 1 as const } },
        { point: { x: w.x2, y: w.y2 }, onPin: pinKeys.has(pointKey({ x: w.x2, y: w.y2 })), wireEnd: { index, end: 2 as const } },
      ]),
    ]
    let best: Grab | null = null
    let bestDistance = radius
    for (const c of candidates) {
      const d = Math.hypot(c.point.x - p.x, c.point.y - p.y)
      if (d < bestDistance - 1e-9 || (best && d <= bestDistance + 1e-9 && c.onPin && !best.onPin)) [best, bestDistance] = [c, d]
    }
    return best
  }

  const beginDrag = (e: ReactPointerEvent, drag: Drag) => {
    dragRef.current = drag
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  // ---------- Wire drafts: every way of drawing ends up here ----------

  const startDraft = (at: Point) => setDraft({ points: [at], cursor: at, horizontalFirst: null })

  /** Adds the wires along `points` as one undo step and ends the draft. */
  const finishDraft = (points: Point[]) => {
    setDraft(null)
    const wires = polylineWires(points)
    if (wires.length === 0) return
    onBeginEdit()
    onChange({ ...schematic, wires: [...schematic.wires, ...wires] })
  }

  /** A click while drawing: route to it and place a corner there; ending on a pin or wire connects and finishes. */
  const placeCorner = (at: Point) => {
    if (!draft) return
    const path = draftPath({ ...draft, cursor: at })
    if (path.length > 1 && isConnection(at, schematic.wires, pinKeys)) finishDraft(path)
    else setDraft({ points: path, cursor: at, horizontalFirst: null })
  }

  const moveDraftCursor = (p: Point) => {
    if (!draft) return
    const cursor = snapPoint(p)
    const last = draft.points[draft.points.length - 1]
    // The first move away from the last corner decides which leg of the L comes first.
    const horizontalFirst =
      draft.horizontalFirst ?? (pointKey(cursor) === pointKey(last) ? null : Math.abs(p.x - last.x) >= Math.abs(p.y - last.y))
    setDraft({ ...draft, cursor, horizontalFirst })
  }

  // ---------- Pointer input ----------

  /** Runs before the parts' and wires' own handlers: drafts and pin/wire ends take precedence over them. */
  const onPointerDownCapture = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const p = toWorld(e)
    const press = { startX: e.clientX, startY: e.clientY, moved: false }
    if (draft) {
      e.stopPropagation()
      placeCorner(snapPoint(p))
      beginDrag(e, { kind: 'draw', ...press })
      return
    }
    if (tool === 'wire') {
      e.stopPropagation()
      startDraft(grabAt(p)?.point ?? snapPoint(p))
      beginDrag(e, { kind: 'draw', ...press })
      return
    }
    if (tool !== 'select') return
    const grab = grabAt(p)
    if (!grab) return
    e.stopPropagation()
    // From a pin, or with Shift from a wire end: a new wire. From a loose wire end: move that end.
    if (grab.onPin || e.shiftKey || !grab.wireEnd) {
      startDraft(grab.point)
      beginDrag(e, { kind: 'draw', ...press })
    } else {
      onSelect(null)
      setItem({ kind: 'wire', index: grab.wireEnd.index })
      beginDrag(e, { kind: 'wire-end', ...grab.wireEnd, ...press, base: schematic })
    }
  }

  const askLabelName = (current = '') => window.prompt('Net name (labels with the same name are connected)', current)?.trim()

  const onBackgroundPointerDown = (e: ReactPointerEvent) => {
    if (e.button === 0 && tool === 'label') {
      const at = snapPoint(toWorld(e))
      const name = askLabelName()
      if (!name) return
      onBeginEdit()
      onChange({ ...schematic, labels: [...schematic.labels, { ...at, name }] })
      return
    }
    // As on the PCB: the left button draws a selection rectangle, the middle button pans.
    if (e.button === 0 && tool === 'select') {
      beginDrag(e, { kind: 'marquee', start: toWorld(e), startX: e.clientX, startY: e.clientY, additive: isToggleClick(e) })
      return
    }
    beginDrag(e, { kind: 'pan', startX: e.clientX, startY: e.clientY, view })
  }

  /** In the label tool everything acts as background. */
  const selectToolOnly = (e: ReactPointerEvent) => e.button === 0 && tool === 'select'

  /** Pressing a part of a multi-selection drags the whole group; otherwise the part alone. */
  const onPartPointerDown = (e: ReactPointerEvent, placement: SchematicPlacement) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    const pressed = placement.ref
    const toggle = isToggleClick(e)
    const group = selection?.kind === 'multi' && selection.refs.includes(pressed) ? selection.refs : [pressed]
    if (group.length === 1 && !toggle) onSelect({ kind: 'part', ref: pressed })
    const origins = schematic.placements.filter((p) => group.includes(p.ref))
    beginDrag(e, { kind: 'parts', pressed, toggle, start: toWorld(e), origins, base: schematic, moved: false })
  }

  const onWirePointerDown = (e: ReactPointerEvent, index: number) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    onSelect(null)
    setItem({ kind: 'wire', index })
    beginDrag(e, { kind: 'wire-shift', index, start: toWorld(e), base: schematic, moved: false })
  }

  const onLabelPointerDown = (e: ReactPointerEvent, index: number) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    onSelect(null)
    setItem({ kind: 'label', index })
  }

  const renameLabel = (index: number) => {
    const name = askLabelName(schematic.labels[index].name)
    if (!name) return
    onBeginEdit()
    onChange({ ...schematic, labels: schematic.labels.map((l, k) => (k === index ? { ...l, name } : l)) })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const p = toWorld(e)
    const drag = dragRef.current
    moveDraftCursor(p)
    if (!drag) {
      setOverPoint(tool === 'select' && grabAt(p) !== null)
      return
    }
    if (drag.kind === 'pan') {
      setView({ ...drag.view, ox: drag.view.ox + e.clientX - drag.startX, oy: drag.view.oy + e.clientY - drag.startY })
      return
    }
    if (drag.kind === 'marquee') {
      setMarquee(rectBetween(drag.start, p))
      return
    }
    if (drag.kind === 'draw' || drag.kind === 'wire-end') {
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) return
      if (drag.kind === 'wire-end' && !drag.moved) {
        onBeginEdit()
        // The moved wire may be split into an L, so its index no longer names it.
        setItem(null)
      }
      drag.moved = true
      if (drag.kind === 'wire-end') onChange(withWireEndMoved(drag.base, drag.index, drag.end, snapPoint(p)))
      return
    }
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    if (!drag.moved) {
      if (Math.hypot(dx, dy) * view.scale <= CLICK_TOLERANCE_PX) return
      drag.moved = true
      onBeginEdit()
    }
    if (drag.kind === 'wire-shift') {
      setItem(null)
      onChange(withWireShifted(drag.base, drag.index, snapPoint({ x: dx, y: dy }), pinKeys))
      return
    }
    // A part rotated mid-drag (Space) keeps its new rotation; `base` still maps its old pin ends.
    const rotations = new Map(schematic.placements.map((p) => [p.ref, p.rotation]))
    const moved = drag.origins.map((origin) => ({
      ...origin,
      rotation: rotations.get(origin.ref) ?? origin.rotation,
      ...snapPoint({ x: origin.x + dx, y: origin.y + dy }),
    }))
    onChange(withPlacementChanges(drag.base, netlist, moved))
  }

  const finishMarquee = (drag: Extract<Drag, { kind: 'marquee' }>, e: ReactPointerEvent) => {
    setMarquee(null)
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) {
      if (drag.additive) return
      onSelect(null)
      setItem(null)
      return
    }
    const area = rectBetween(drag.start, toWorld(e))
    const refs = parts.filter(({ pins }) => {
      const partBounds = partArea(pins)
      return partBounds !== null && rectsOverlap(partBounds, area)
    }).map(({ placement }) => placement.ref)
    onSelect(drag.additive ? addToSelection(selection, refs, []) : selectionOf(refs, []))
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    svgRef.current!.releasePointerCapture(e.pointerId)
    if (drag?.kind === 'marquee') finishMarquee(drag, e)
    if (drag?.kind === 'parts' && !drag.moved) {
      const part = { kind: 'part', ref: drag.pressed } as const
      onSelect(drag.toggle ? toggleSelected(selection, part) : part)
    }
    if (drag?.kind !== 'draw' || !draft) return
    // A drag draws one wire; a click in the wire tool goes on corner by corner. In the select
    // tool a click on a pin end is not meant as drawing.
    if (drag.moved) finishDraft(draftPath(draft))
    else if (tool === 'select') setDraft(null)
  }

  // ---------- Keys ----------

  const removeItem = () => {
    if (!item) return false
    onBeginEdit()
    if (item.kind === 'wire') onChange({ ...schematic, wires: schematic.wires.filter((_, k) => k !== item.index) })
    else onChange({ ...schematic, labels: schematic.labels.filter((_, k) => k !== item.index) })
    setItem(null)
    return true
  }

  /** Keys while drawing or with a wire or label selected; returns true when handled. */
  const handleKey = (e: KeyboardEvent): boolean => {
    if (draft && e.key === ' ') {
      setDraft({ ...draft, horizontalFirst: !(draft.horizontalFirst ?? true) })
      return true
    }
    if (draft && e.key === 'Escape') {
      // Keeps the corners placed so far; only the leg to the pointer is dropped.
      finishDraft(draft.points)
      return true
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return removeItem()
    if (e.key === 'Escape' && item) {
      setItem(null)
      return true
    }
    return false
  }
  const handleKeyRef = useRef(handleKey)
  handleKeyRef.current = handleKey
  useEffect(() => {
    // Capture phase, so a key used here (Space while drawing) does not also reach the app's shortcuts.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (!handleKeyRef.current(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // ---------- Drawing ----------

  const pinDirections = new Map(parts.flatMap(({ pins }) => pins.map((pin) => [pointKey(pin), { x: pin.dx, y: pin.dy }] as const)))
  const conflictPoints = new Set(nets.conflicts.flatMap((c) => c.points.map(pointKey)))
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale, GRID_PITCHES_MM)
  const preview = draft && draftPath(draft)
  return (
    <div className="schematic-view">
      <svg
        ref={svgRef}
        className={`schematic tool-${tool}${overPoint || draft ? ' over-point' : ''}`}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => draft && finishDraft(draft.points)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${view.ox} ${view.oy}) scale(${view.scale})`}>
          {/* No origin axes or rulers: a schematic has no physical position, they only distract. */}
          <ViewportGrid view={view} size={size} pitch={pitch} axes={false} />
          {schematic.wires.map((w, k) => {
            const selected = item?.kind === 'wire' && item.index === k
            return (
              <g key={k} className={selected ? 'sch-wire-item selected' : 'sch-wire-item'} onPointerDown={(e) => onWirePointerDown(e, k)}>
                <line className="sch-wire-hit" x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} strokeWidth={8 * px} />
                <line className="sch-wire" x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} />
              </g>
            )
          })}
          {parts.map(({ component, placement, pins }) => (
            <SchematicPart
              key={placement.ref}
              component={component}
              placement={placement}
              pins={pins}
              selected={highlightedRefs.has(placement.ref)}
              onPointerDown={(e) => onPartPointerDown(e, placement)}
            />
          ))}
          {nets.junctions.map((p) => (
            <circle key={pointKey(p)} className="sch-junction" cx={p.x} cy={p.y} r={0.55} />
          ))}
          {schematic.labels.map((label, k) => {
            const selected = item?.kind === 'label' && item.index === k
            const conflict = conflictPoints.has(pointKey(label))
            return (
              <LabelMark
                key={k}
                label={label}
                direction={pinDirections.get(pointKey(label)) ?? { x: 1, y: 0 }}
                className={['sch-label', selected && 'selected', conflict && 'conflict'].filter(Boolean).join(' ')}
                onPointerDown={(e) => onLabelPointerDown(e, k)}
                onDoubleClick={() => renameLabel(k)}
              />
            )
          })}
          {preview && <polyline className="sch-wire preview" points={preview.map((q) => `${q.x},${q.y}`).join(' ')} />}
          {marquee && (
            <rect
              className="marquee"
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              strokeWidth={px}
              strokeDasharray={`${4 * px} ${3 * px}`}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>
      {nets.conflicts.length > 0 && (
        <div className="schematic-conflicts" role="alert">
          {nets.conflicts.map((c) => `Shorted: ${c.names.join(' + ')}`).join(' · ')}
        </div>
      )}
      {parts.length === 0 && <p className="schematic-empty">Import a netlist to see its schematic.</p>}
    </div>
  )
}
