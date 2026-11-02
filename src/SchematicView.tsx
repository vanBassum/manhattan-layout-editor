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
  withSchematicMoved,
  withTidyWires,
  type FullSchematic,
  type SchematicNets,
} from './schematic'
import { componentSymbol } from './definitions'
import type { PinEnd } from './schematic'
import type { SymbolGraphic } from './types'
import {
  addToSelection,
  isSchematicItemSelected,
  isToggleClick,
  schematicItemSelection,
  selectedNets,
  selectedRefs,
  selectedWiring,
  selectionOf,
  toggleSchematicItem,
  type SchematicItem,
} from './selection'
import type { NetComponent, NetLabel, Netlist, Point, Rect, SchematicPlacement, Selection, Wire, WiringSelection } from './types'
import { gridPitch, useViewport, ViewportGrid, type View } from './viewport'
import { layerOpacities, type LayerView } from './Canvas'

/**
 * Select: drag parts; drag from a pin end to draw a wire; drag a wire end to move it, or a wire
 * sideways to shift it. Wire: drag for one wire, or click corner by corner. Label: click to name a point.
 */
export type SchematicTool = 'select' | 'wire' | 'label'

export type SchematicLayer = 'grid' | 'references' | 'values' | 'pinNumbers'

/** View-only: which parts of the drawing are shown, and how strongly. A per-browser preference, not part of the project. */
export type SchematicLayers = Record<SchematicLayer, LayerView>

const hiddenLayerClasses = (layers: SchematicLayers) =>
  (Object.keys(layers) as SchematicLayer[]).filter((layer) => !layers[layer].visible).map((layer) => ` hide-${layer}`).join('')

/** Schematic grid pitches in mm: 0.1 inch and up; every fifth line is solid. Pins sit on the finest one. */
const GRID_PITCHES_MM = [SCHEMATIC_GRID, 12.7, 63.5, 317.5]

/** A press that moves less than this (screen pixels) is a click, not a drag. */
const CLICK_TOLERANCE_PX = 3
/** How close (screen pixels) the pointer must be to grab a pin end or wire end. */
const GRAB_RADIUS_PX = 8
/**
 * Never further than this (mm): zoomed out, 8 pixels would cover most of a small symbol, and a
 * press meant to move the part would start a wire instead.
 */
const MAX_GRAB_RADIUS_MM = 1

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
   * The pressed item, or the whole selection when it is in it (`moving`). Each step is applied to
   * `base`, the schematic at the start, shifted by `delta`. `keepConnections`: drag (the wiring
   * around it stretches along) or, with Shift, move (only the selection moves). A press that ends
   * without moving selects `pressed` alone, or with `toggle` set, toggles it in the selection.
   */
  | {
      kind: 'selection'
      pressed: SchematicItem
      toggle: boolean
      keepConnections: boolean
      start: Point
      moving: Selection
      base: FullSchematic
      delta: Point
      moved: boolean
    }
  /** A press that starts or continues a wire draft: dragging finishes it on release, a click keeps drawing. */
  | { kind: 'draw'; startX: number; startY: number; moved: boolean }

/** A pin end or wire end under the pointer. */
interface Grab {
  point: Point
  onPin: boolean
  wireEnd?: { index: number; end: 1 | 2 }
}

const snapPoint = (p: Point): Point => ({ x: snapToGrid(p.x, SCHEMATIC_GRID), y: snapToGrid(p.y, SCHEMATIC_GRID) })

const pointInside = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
const rectInside = (inner: Rect, outer: Rect) =>
  pointInside(inner, outer) && pointInside({ x: inner.x + inner.w, y: inner.y + inner.h }, outer)
/** True when the wire touches the rectangle; wires are horizontal or vertical, so their bounding box will do. */
const wireTouches = (w: Wire, r: Rect) =>
  Math.max(w.x1, w.x2) >= r.x && Math.min(w.x1, w.x2) <= r.x + r.w && Math.max(w.y1, w.y2) >= r.y && Math.min(w.y1, w.y2) <= r.y + r.h

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
  // No dot on the point: on a wire it would look like a junction. The name alone marks the label.
  return (
    <g className={className} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
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

const MIRRORED_ANCHOR = { start: 'end', middle: 'middle', end: 'start' } as const

/** One drawing element of a symbol definition. In a mirrored symbol, text is mirrored back so it stays readable. */
function SymbolShape({ graphic, mirrored }: { graphic: SymbolGraphic; mirrored: boolean }) {
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
        <text
          className={graphic.style === 'mark' ? 'sch-pin-mark' : 'sch-pin-number'}
          x={mirrored ? -graphic.x : graphic.x}
          y={graphic.y}
          textAnchor={mirrored ? MIRRORED_ANCHOR[graphic.anchor] : graphic.anchor}
          transform={mirrored ? 'scale(-1 1)' : undefined}
        >
          {graphic.text}
        </text>
      )
  }
}

/**
 * An invisible copy of a symbol element that catches the pointer: the shape itself plus a margin
 * along its outline. Following the drawing instead of a box around the pins keeps a big symbol
 * (a transistor) from covering a small one placed close to it.
 */
function SymbolHitShape({ graphic }: { graphic: SymbolGraphic }) {
  switch (graphic.type) {
    case 'line':
      return <polyline className="sch-hit-shape" points={pointList(graphic.points)} fill="none" />
    case 'polygon':
      return <polygon className="sch-hit-shape" points={pointList(graphic.points)} />
    case 'rect':
      return <rect className="sch-hit-shape" x={graphic.x} y={graphic.y} width={graphic.w} height={graphic.h} />
    case 'circle':
      return <circle className="sch-hit-shape" cx={graphic.x} cy={graphic.y} r={graphic.r} />
    case 'text':
      return null
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
  const mirrored = placement.mirrored ?? false
  const labelOffset = rotatePoint(symbol.label, rotation)
  const label = { x: x + labelOffset.x, y: y + labelOffset.y }
  return (
    <g className={selected ? 'sch-part selected' : 'sch-part'} onPointerDown={onPointerDown}>
      <title>{`${component.ref} ${component.value}`}</title>
      <g transform={`translate(${x} ${y}) rotate(${rotation})${mirrored ? ' scale(-1 1)' : ''}`}>
        {symbol.graphics.map((graphic, k) => (
          <SymbolHitShape key={`hit${k}`} graphic={graphic} />
        ))}
        {symbol.graphics.map((graphic, k) => (
          <SymbolShape key={k} graphic={graphic} mirrored={mirrored} />
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
  layers: SchematicLayers
}

export function SchematicView({ netlist, schematic, nets, onChange, onBeginEdit, selection, onSelect, tool, fitRequest, layers }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [draft, setDraft] = useState<WireDraft | null>(null)
  const [overPoint, setOverPoint] = useState(false)
  const [marquee, setMarquee] = useState<{ rect: Rect; crossing: boolean } | null>(null)
  const { view, setView, size, fitTo } = useViewport(svgRef)
  const highlightedRefs = new Set(selectedRefs(selection))
  const wiring = selectedWiring(selection)
  const highlightedWires = new Set(wiring.wires)
  const highlightedLabels = new Set(wiring.labels)

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

  // A draft belongs to the tool it was started in.
  useEffect(() => setDraft(null), [tool])

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale }
  }

  /** The nearest pin end or wire end within grabbing distance; a pin wins over a wire end on the same spot. */
  const grabAt = (p: Point): Grab | null => {
    const radius = Math.min(GRAB_RADIUS_PX / view.scale, MAX_GRAB_RADIUS_MM)
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
    // From a pin, or with Shift from a wire end: a new wire. A loose wire end, corner or junction
    // is an item of its own: pressing it selects it, dragging it takes every wire end there along.
    if (grab.onPin || e.shiftKey || !grab.wireEnd) {
      e.stopPropagation()
      startDraft(grab.point)
      beginDrag(e, { kind: 'draw', ...press })
    } else {
      pressItem(e, { kind: 'point', point: grab.point })
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

  /**
   * Pressing an item of the selection drags the whole selection; otherwise the item alone is
   * selected and dragged. Shift+drag moves instead of drags, as on the PCB, where Shift+drag takes
   * the leads along. A Shift/Ctrl press that ends without dragging toggles the item instead.
   */
  const pressItem = (e: ReactPointerEvent, pressed: SchematicItem) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    const toggle = isToggleClick(e)
    const inSelection = isSchematicItemSelected(selection, pressed)
    const moving = inSelection ? selection : schematicItemSelection(pressed)
    if (!inSelection && !toggle) onSelect(moving)
    beginDrag(e, {
      kind: 'selection',
      pressed,
      toggle,
      keepConnections: !e.shiftKey,
      start: toWorld(e),
      moving,
      base: schematic,
      delta: { x: 0, y: 0 },
      moved: false,
    })
  }

  /**
   * Dragging one wire on its own shifts it sideways only: sliding it along itself would just bend
   * the wires at its ends. Everything else follows the pointer.
   */
  const alongDragAxis = (drag: Extract<Drag, { kind: 'selection' }>, d: Point): Point => {
    const moving = selectedWiring(drag.moving)
    const loneWire = drag.keepConnections && selectedRefs(drag.moving).length === 0 && moving.wires.length === 1 && moving.labels.length === 0
    const w = loneWire ? drag.base.wires[moving.wires[0]] : undefined
    if (!w || moving.points.length > 0) return d
    if (w.y1 === w.y2) return { x: 0, y: d.y }
    if (w.x1 === w.x2) return { x: d.x, y: 0 }
    return d
  }

  /** The schematic with `moving` shifted by `delta` from `base`. Parts keep a rotation or flip made mid-drag. */
  const movedSchematic = (drag: Extract<Drag, { kind: 'selection' }>) => {
    const refs = selectedRefs(drag.moving)
    const current = new Map(schematic.placements.map((p) => [p.ref, p]))
    const placements = drag.base.placements
      .filter((p) => refs.includes(p.ref))
      .map((origin) => ({ ...(current.get(origin.ref) ?? origin), ...snapPoint({ x: origin.x + drag.delta.x, y: origin.y + drag.delta.y }) }))
    return withSchematicMoved(drag.base, netlist, {
      placements,
      wiring: selectedWiring(drag.moving),
      delta: drag.delta,
      keepConnections: drag.keepConnections,
    })
  }

  /** After a drag: folded-up wires go, and the selection follows the wires and points that moved. */
  const finishMove = (drag: Extract<Drag, { kind: 'selection' }>) => {
    const moving = selectedWiring(drag.moving)
    const { schematic: tidy, selectedWires } = withTidyWires(schematic, moving.wires)
    if (tidy.wires.length !== schematic.wires.length) onChange(tidy)
    if (drag.moving !== selection) return
    const { x: dx, y: dy } = drag.delta
    const points = moving.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
    onSelect(selectionOf(selectedRefs(selection), selectedNets(selection), { ...moving, wires: selectedWires, points }))
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
      setMarquee({ rect: rectBetween(drag.start, p), crossing: p.x < drag.start.x })
      return
    }
    if (drag.kind === 'draw') {
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) return
      drag.moved = true
      return
    }
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    if (!drag.moved) {
      if (Math.hypot(dx, dy) * view.scale <= CLICK_TOLERANCE_PX) return
      drag.moved = true
      onBeginEdit()
    }
    drag.delta = snapPoint(alongDragAxis(drag, { x: dx, y: dy }))
    onChange(movedSchematic(drag))
  }

  /**
   * Dragged left to right (a window), the rectangle selects what lies entirely inside it; right to
   * left (crossing), whatever it touches. Either way, wire ends inside it go along with a drag, so
   * a wire reaching out of the window stretches; ends on a pin follow that pin instead.
   */
  const finishMarquee = (drag: Extract<Drag, { kind: 'marquee' }>, e: ReactPointerEvent) => {
    setMarquee(null)
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) {
      if (!drag.additive) onSelect(null)
      return
    }
    const end = toWorld(e)
    const area = rectBetween(drag.start, end)
    const crossing = end.x < drag.start.x
    const refs = parts
      .filter(({ pins }) => {
        const partBounds = partArea(pins)
        return partBounds !== null && (crossing ? rectsOverlap(partBounds, area) : rectInside(partBounds, area))
      })
      .map(({ placement }) => placement.ref)
    const ends = new Map(
      schematic.wires
        .flatMap((w) => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }])
        .filter((p) => pointInside(p, area) && !pinKeys.has(pointKey(p)))
        .map((p) => [pointKey(p), p]),
    )
    const found: WiringSelection = {
      wires: schematic.wires.flatMap((w, i) => {
        const inside = pointInside({ x: w.x1, y: w.y1 }, area) && pointInside({ x: w.x2, y: w.y2 }, area)
        return inside || (crossing && wireTouches(w, area)) ? [i] : []
      }),
      labels: schematic.labels.flatMap((l, i) => (pointInside(l, area) ? [i] : [])),
      points: [...ends.values()],
    }
    onSelect(drag.additive ? addToSelection(selection, refs, [], found) : selectionOf(refs, [], found))
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    svgRef.current!.releasePointerCapture(e.pointerId)
    if (drag?.kind === 'marquee') finishMarquee(drag, e)
    if (drag?.kind === 'selection') {
      if (drag.moved) finishMove(drag)
      else onSelect(drag.toggle ? toggleSchematicItem(selection, drag.pressed) : schematicItemSelection(drag.pressed))
    }
    if (drag?.kind !== 'draw' || !draft) return
    // A drag draws one wire; a click in the wire tool goes on corner by corner. In the select
    // tool a click on a pin end is not meant as drawing.
    if (drag.moved) finishDraft(draftPath(draft))
    else if (tool === 'select') setDraft(null)
  }

  // ---------- Keys ----------

  /** Deletes the selected wires and labels; parts come from the netlist and stay. */
  const removeSelectedWiring = () => {
    if (wiring.wires.length === 0 && wiring.labels.length === 0) return false
    onBeginEdit()
    onChange({
      ...schematic,
      wires: schematic.wires.filter((_, k) => !highlightedWires.has(k)),
      labels: schematic.labels.filter((_, k) => !highlightedLabels.has(k)),
    })
    onSelect(selectionOf(selectedRefs(selection), selectedNets(selection)))
    return true
  }

  /** Keys while drawing or with wiring selected; returns true when handled. */
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
    if (e.key === 'Delete' || e.key === 'Backspace') return removeSelectedWiring()
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
  /** Which way a label's name points: away from its pin, above a horizontal wire, else to the right. */
  const labelDirection = (label: NetLabel): Point => {
    const pin = pinDirections.get(pointKey(label))
    if (pin) return pin
    const onHorizontalWire = schematic.wires.some((w) => w.y1 === w.y2 && w.y1 === label.y && Math.min(w.x1, w.x2) <= label.x && label.x <= Math.max(w.x1, w.x2))
    return onHorizontalWire ? { x: 0, y: -1 } : { x: 1, y: 0 }
  }
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale, GRID_PITCHES_MM)
  const preview = draft && draftPath(draft)
  return (
    <div className="schematic-view">
      <svg
        ref={svgRef}
        className={`schematic tool-${tool}${overPoint || draft ? ' over-point' : ''}${hiddenLayerClasses(layers)}`}
        style={layerOpacities(layers)}
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
            const selected = highlightedWires.has(k)
            return (
              <g
                key={k}
                className={selected ? 'sch-wire-item selected' : 'sch-wire-item'}
                onPointerDown={(e) => pressItem(e, { kind: 'wire', index: k })}
              >
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
              onPointerDown={(e) => pressItem(e, { kind: 'part', ref: placement.ref })}
            />
          ))}
          {nets.junctions.map((p) => (
            <circle key={pointKey(p)} className="sch-junction" cx={p.x} cy={p.y} r={0.55} />
          ))}
          {wiring.points.map((p) => (
            <rect key={pointKey(p)} className="sch-point selected" x={p.x - 0.6} y={p.y - 0.6} width={1.2} height={1.2} pointerEvents="none" />
          ))}
          {schematic.labels.map((label, k) => {
            const selected = highlightedLabels.has(k)
            const conflict = conflictPoints.has(pointKey(label))
            return (
              <LabelMark
                key={k}
                label={label}
                direction={labelDirection(label)}
                className={['sch-label', selected && 'selected', conflict && 'conflict'].filter(Boolean).join(' ')}
                onPointerDown={(e) => pressItem(e, { kind: 'label', index: k })}
                onDoubleClick={() => renameLabel(k)}
              />
            )
          })}
          {preview && <polyline className="sch-wire preview" points={preview.map((q) => `${q.x},${q.y}`).join(' ')} />}
          {marquee && (
            <rect
              className="marquee"
              x={marquee.rect.x}
              y={marquee.rect.y}
              width={marquee.rect.w}
              height={marquee.rect.h}
              strokeWidth={px}
              // Dashed while it selects what it touches (dragged right to left), solid for what lies inside.
              strokeDasharray={marquee.crossing ? `${4 * px} ${3 * px}` : undefined}
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
