import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, inflate, rectBetween, rotatePoint, snapToGrid } from './geometry'
import {
  alongDragAxis,
  CELL_HEIGHT,
  CELL_WIDTH,
  draggedSchematic,
  grabAt,
  isConnection,
  labelDirection,
  labelSymbol,
  looseWireEnds,
  marqueeSelection,
  pinKeysOf,
  placedParts,
  pointKey,
  polylineWires,
  route,
  SCHEMATIC_GRID,
  snapPoint,
  withTidyWires,
  type FullSchematic,
  type PinEnd,
  type SchematicNets,
} from './schematic'
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
import type { BuiltComponent, BuiltNetlist, NetLabel, Point, Rect, SchematicPlacement, Selection } from './types'
import { layerClasses, layerOpacities, type SchematicLayers } from './ui/layers'
import { gridPitch, gridPitches, useViewport, ViewportGrid, type View } from './ui/viewport'

/**
 * Select: drag parts; drag from a pin end to draw a wire; drag a wire end to move it, or a wire
 * sideways to shift it. Wire: drag for one wire, or click corner by corner. Label: click to name a point.
 */
export type SchematicTool = 'select' | 'wire' | 'label'

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
  /** A part's reference and value text, dragged on its own; the part stays where it is. */
  | { kind: 'part-text'; ref: string; start: Point; origin: Point; moved: boolean }

type SelectionDrag = Extract<Drag, { kind: 'selection' }>
type MarqueeDrag = Extract<Drag, { kind: 'marquee' }>

/** Text placed `distance` mm from `at` along `axis`, reading upright whichever way the axis points. */
function textAlong(at: Point, axis: Point, distance: number) {
  const x = at.x + axis.x * distance
  const y = at.y + axis.y * distance
  if (axis.x !== 0) return { x, y: y + 0.45, anchor: axis.x > 0 ? ('start' as const) : ('end' as const) }
  return { x, y: axis.y > 0 ? y + 0.9 : y, anchor: 'middle' as const }
}

const TERMINAL_RADIUS = 0.9

interface LabelProps {
  label: NetLabel
  /** Direction of the pin the label sits on, so the text points away from the part. */
  direction: Point
  className: string
  onPointerDown: (e: ReactPointerEvent) => void
  onDoubleClick: () => void
}

/**
 * Ground and power symbols are drawn pointing down and up at rotation 0, turning with the label's
 * rotation while their name stays upright beyond the symbol's end. Any other net is just its name.
 */
function LabelMark({ label, direction, className, onPointerDown, onDoubleClick }: LabelProps) {
  const { x, y, name } = label
  const symbol = labelSymbol(label)
  const rotation = label.rotation ?? 0
  const turned = `translate(${x} ${y}) rotate(${rotation})`
  if (symbol === 'ground') {
    // The usual earth sign: a stub down to three bars, each shorter than the one above.
    const text = textAlong(label, rotatePoint({ x: 0, y: 1 }, rotation), 4.3)
    return (
      <g className={className} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        <g transform={turned}>
          <rect className="sch-hit" x={-1.8} y={0} width={3.6} height={4.2} />
          <polyline className="sch-line" points="0,0 0,2.54" />
          <polyline className="sch-line" points="-1.52,2.54 1.52,2.54" />
          <polyline className="sch-line" points="-0.96,3.18 0.96,3.18" />
          <polyline className="sch-line" points="-0.4,3.82 0.4,3.82" />
        </g>
        <text className="sch-net" x={text.x} y={text.y} textAnchor={text.anchor}>
          {name}
        </text>
      </g>
    )
  }
  if (symbol === 'power') {
    // A supply port as in the reference drawing: a stub up to a bar, the name above it.
    const text = textAlong(label, rotatePoint({ x: 0, y: -1 }, rotation), 3.44)
    return (
      <g className={className} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        <g transform={turned}>
          <rect className="sch-hit" x={-1.8} y={-4.54} width={3.6} height={4.6} />
          <polyline className="sch-line" points="0,0 0,-2.54" />
          <rect className="sch-fill" x={-1.52} y={-2.84} width={3.04} height={0.6} />
        </g>
        <text className="sch-net" x={text.x} y={text.y} textAnchor={text.anchor}>
          {name}
        </text>
      </g>
    )
  }
  // A terminal's name sits beyond its circle; a plain net name right at the point.
  const gap = symbol === 'terminal' ? TERMINAL_RADIUS : 0
  const horizontal = direction.x !== 0
  const textX = x + direction.x * (0.6 + gap)
  const textY = horizontal ? y + 0.45 : y + direction.y * (1.2 + gap) + (direction.y > 0 ? 0.9 : 0)
  const anchor = horizontal ? (direction.x > 0 ? 'start' : 'end') : 'middle'
  if (symbol === 'terminal') {
    // A connection point: an open circle with a slash, filled with the background so a wire ends at its edge.
    const slash = TERMINAL_RADIUS * Math.SQRT1_2
    return (
      <g className={className} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
        <circle className="sch-plate-open" cx={x} cy={y} r={TERMINAL_RADIUS} />
        <polyline className="sch-line" points={`${x - slash},${y + slash} ${x + slash},${y - slash}`} />
        <text className="sch-net" x={textX} y={textY} textAnchor={anchor}>
          {name}
        </text>
      </g>
    )
  }
  // No dot on the point: on a wire it would look like a junction. The name alone marks the label.
  return (
    <g className={`${className} net-name`} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
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

/** Where the part's reference and value text starts, relative to its origin: moved by hand, or the symbol's own spot. */
const textOffsetOf = (component: BuiltComponent, placement: SchematicPlacement): Point =>
  placement.textOffset ?? rotatePoint(component.symbol.label, placement.rotation)

/** Reference and value text moves in quarter grid steps: finer than parts, so it can be fitted between wires. */
const TEXT_STEP = SCHEMATIC_GRID / 4

interface PartProps {
  component: BuiltComponent
  placement: SchematicPlacement
  pins: PinEnd[]
  selected: boolean
  onPointerDown: (e: ReactPointerEvent) => void
  /** Pressing the reference or value text: it can be dragged on its own. */
  onTextPointerDown: (e: ReactPointerEvent) => void
}

/** The body rotates with the part; reference and value stay upright. Unconnected pins get an open circle. */
function SchematicPart({ component, placement, pins, selected, onPointerDown, onTextPointerDown }: PartProps) {
  const { symbol } = component
  const { x, y, rotation } = placement
  const mirrored = placement.mirrored ?? false
  const textOffset = textOffsetOf(component, placement)
  const label = { x: x + textOffset.x, y: y + textOffset.y }
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
      <g className="sch-part-text" onPointerDown={onTextPointerDown}>
        <text className="sch-ref" x={label.x} y={label.y}>{component.ref}</text>
        <text className="sch-value" x={label.x} y={label.y + 1.5}>{component.value}</text>
      </g>
      {pins.map((pin, k) => !component.pins[k]?.net && <circle key={k} className="sch-open-pin" cx={pin.x} cy={pin.y} r={0.5} />)}
    </g>
  )
}

interface Props {
  /** As built, with the nets the schematic gives. */
  netlist: BuiltNetlist
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
  /** Fine grid steps (0.1 inch, where pins sit) between two solid grid lines. */
  gridLinesPerMajor: number
}

export function SchematicView({
  netlist,
  schematic,
  nets,
  onChange,
  onBeginEdit,
  selection,
  onSelect,
  tool,
  fitRequest,
  layers,
  gridLinesPerMajor,
}: Props) {
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

  const parts = placedParts(schematic, netlist)
  const pinKeys = pinKeysOf(parts)
  const grabRadius = Math.min(GRAB_RADIUS_PX / view.scale, MAX_GRAB_RADIUS_MM)

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
      startDraft(grabAt(schematic.wires, parts, p, grabRadius)?.point ?? snapPoint(p))
      beginDrag(e, { kind: 'draw', ...press })
      return
    }
    if (tool !== 'select') return
    const grab = grabAt(schematic.wires, parts, p, grabRadius)
    if (!grab) return
    // From a pin, or with Shift from a wire end: a new wire. A loose wire end, corner or junction
    // is an item of its own: pressing it selects it, dragging it takes every wire end there along.
    if (grab.onPin || e.shiftKey) {
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
      // The symbol is decided once, from the name; renaming it later keeps it.
      onChange({ ...schematic, labels: [...schematic.labels, { ...at, name, symbol: labelSymbol({ ...at, name }) }] })
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

  /** Pressing a part's text selects the part; dragging moves only the text. */
  const pressPartText = (e: ReactPointerEvent, component: BuiltComponent, placement: SchematicPlacement) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    onSelect({ kind: 'part', ref: placement.ref })
    beginDrag(e, { kind: 'part-text', ref: placement.ref, start: toWorld(e), origin: textOffsetOf(component, placement), moved: false })
  }


  /** After a drag: folded-up wires go, and the selection follows the wires and points that moved. */
  const finishMove = (drag: SelectionDrag) => {
    const moving = selectedWiring(drag.moving)
    // Where the drag kept every connection, it should leave no loose end that was not there before.
    const baseLoose = looseWireEnds(drag.base, netlist)
    const allowedLooseEnds = drag.keepConnections
      ? [...baseLoose, ...baseLoose.map((p) => ({ x: p.x + drag.delta.x, y: p.y + drag.delta.y }))]
      : undefined
    const { schematic: tidy, selectedWires, changed } = withTidyWires(schematic, netlist, moving.wires, allowedLooseEnds)
    if (changed) onChange(tidy)
    if (drag.moving !== selection) return
    const { x: dx, y: dy } = drag.delta
    const points = moving.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
    onSelect(selectionOf(selectedRefs(selection), selectedNets(selection), { ...moving, wires: selectedWires, points }))
  }

  const renameLabel = (index: number) => {
    const name = askLabelName(schematic.labels[index].name)
    if (!name) return
    onBeginEdit()
    onChange({ ...schematic, labels: schematic.labels.map((l, k) => (k === index ? { ...l, name, symbol: labelSymbol(l) } : l)) })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const p = toWorld(e)
    const drag = dragRef.current
    moveDraftCursor(p)
    if (!drag) {
      setOverPoint(tool === 'select' && grabAt(schematic.wires, parts, p, grabRadius) !== null)
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
    if (drag.kind === 'part-text') {
      const textOffset = { x: snapToGrid(drag.origin.x + dx, TEXT_STEP), y: snapToGrid(drag.origin.y + dy, TEXT_STEP) }
      onChange({ ...schematic, placements: schematic.placements.map((p) => (p.ref === drag.ref ? { ...p, textOffset } : p)) })
      return
    }
    drag.delta = snapPoint(alongDragAxis(drag, { x: dx, y: dy }))
    onChange(draggedSchematic(schematic, netlist, drag, drag.delta))
  }

  /** Dragged left to right (a window), the rectangle selects what lies inside it; right to left (crossing), whatever it touches. */
  const finishMarquee = (drag: MarqueeDrag, e: ReactPointerEvent) => {
    setMarquee(null)
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) {
      if (!drag.additive) onSelect(null)
      return
    }
    const end = toWorld(e)
    const crossing = end.x < drag.start.x
    const { refs, wiring: found } = marqueeSelection(schematic, parts, rectBetween(drag.start, end), crossing)
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

  const conflictPoints = new Set(nets.conflicts.flatMap((c) => c.points.map(pointKey)))
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale, gridPitches(SCHEMATIC_GRID, gridLinesPerMajor))
  const preview = draft && draftPath(draft)
  return (
    <div className="schematic-view">
      <svg
        ref={svgRef}
        className={['schematic', `tool-${tool}`, (overPoint || draft) && 'over-point', ...layerClasses(layers, { dimFaint: false })].filter(Boolean).join(' ')}
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
          <ViewportGrid view={view} size={size} pitch={pitch} linesPerMajor={gridLinesPerMajor} axes={false} />
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
              onTextPointerDown={(e) => pressPartText(e, component, placement)}
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
                direction={labelDirection(label, parts, schematic.wires)}
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
