import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, inflate, nearestPointOnRects, outlinePath, rectsOverlap, snapToGrid } from './geometry'
import { analyzeLeads, bodyBounds, componentGeometry, toLocal, toWorld as toWorldPoint, type Geometry, type PinStatus } from './layout'
import { addToSelection, isSelected, selectedNets, selectedRefs, selectionOf, toggleSelected, type SingleSelection } from './selection'
import type { Island, Layout, Netlist, Placement, Point, Rect, Selection } from './types'

/** screen = world * scale + offset; scale is pixels per millimeter. */
interface View {
  scale: number
  ox: number
  oy: number
}

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type Side = 'left' | 'right' | 'top' | 'bottom'

/** A rectangle of another net with its `side` on an edge being dragged: the two share that cut. */
interface CutNeighbour {
  net: string
  rectIndex: number
  rect: Rect
  side: Side
}

/** Select: dragging empty space draws a selection rectangle. Pan: it moves the view. */
export type Tool = 'select' | 'pan'

/** Part: the part moves with its bent leads. Body: lead ends stay soldered where they are. */
export type MoveMode = 'part' | 'body'

/** A part as it was when the drag started. With worldLeadEnds set, only the body moves. */
interface MovingPart {
  placement: Placement
  worldLeadEnds?: Record<string, Point>
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: Point; startX: number; startY: number; additive: boolean }
  | { kind: 'island'; net: string; start: Point; rects: Rect[] }
  | { kind: 'resize'; net: string; rectIndex: number; handle: Handle; start: Point; rect: Rect; neighbours: CutNeighbour[] }
  | { kind: 'part'; start: Point; part: MovingPart }
  | { kind: 'group'; start: Point; parts: MovingPart[]; islands: Island[]; pressed: SingleSelection }
  | { kind: 'lead'; pin: string; start: Point; origin: Point; placement: Placement }

type MarqueeDrag = Extract<Drag, { kind: 'marquee' }>
type GroupDrag = Extract<Drag, { kind: 'group' }>

const MIN_RECT_SIZE = 1
/** A press that moves less than this (screen pixels) is a click, not a selection rectangle. */
const CLICK_TOLERANCE_PX = 3
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const PIN_COLORS: Record<PinStatus, string> = {
  ok: '#2e9e44',
  open: '#e0a000',
  short: '#e02020',
  unused: '#888888',
}

export interface LayerView {
  visible: boolean
  /** 0..1 */
  opacity: number
}

export type LayerName = 'islands' | 'parts' | 'netLabels' | 'leads' | 'grid'

/** View-only settings; hidden layers stay in the DOM so the agent screenshot can still show them. */
export type Layers = Record<LayerName, LayerView>

/** Below this opacity a layer ignores clicks, so you can work on what lies underneath it. */
const CLICKABLE_OPACITY = 0.5

function layerClasses(layers: Layers): string {
  const classes = Object.entries(layers).flatMap(([layer, view]) => {
    if (!view.visible) return [`hide-${layer}`]
    return view.opacity < CLICKABLE_OPACITY ? [`dim-${layer}`] : []
  })
  return ['canvas', ...classes].join(' ')
}

/** Fine grid pitches in mm; every fifth line is solid. */
const GRID_PITCHES_MM = [1, 5, 25, 125]
const MIN_GRID_SPACING_PX = 8

/** Finest pitch whose lines stay far enough apart to read at this zoom. */
function gridPitch(scale: number): number {
  return GRID_PITCHES_MM.find((pitch) => pitch * scale >= MIN_GRID_SPACING_PX) ?? GRID_PITCHES_MM[GRID_PITCHES_MM.length - 1]
}

/** CSS variables --opacity-<layer>, read by the stylesheet. */
function layerOpacities(layers: Layers): CSSProperties {
  return Object.fromEntries(Object.entries(layers).map(([layer, view]) => [`--opacity-${layer}`, view.opacity]))
}

interface Props {
  netlist: Netlist
  layout: Layout
  onLayoutChange: (update: (layout: Layout) => Layout) => void
  /** Called once per drag, just before its first change, so the drag can be undone as a whole. */
  onBeginEdit: () => void
  selection: Selection
  onSelect: (selection: Selection) => void
  snap: number
  /** Islands are drawn shrunk by half of this: the copper that remains after cutting. */
  isolation: number
  /** Nets drawn with a red outline: overlapping another net, or split into separate pieces. */
  problemNets: Set<string>
  fitRequest: number
  layers: Layers
  tool: Tool
  moveMode: MoveMode
}

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }

function handleSides(handle: Handle): Side[] {
  const sides: Side[] = []
  if (handle.includes('w')) sides.push('left')
  if (handle.includes('e')) sides.push('right')
  if (handle.includes('n')) sides.push('top')
  if (handle.includes('s')) sides.push('bottom')
  return sides
}

function sideValue(r: Rect, side: Side): number {
  switch (side) {
    case 'left':
      return r.x
    case 'right':
      return r.x + r.w
    case 'top':
      return r.y
    case 'bottom':
      return r.y + r.h
  }
}

/** Moves one edge of the rectangle, keeping the opposite edge and a minimum size. */
function withSide(r: Rect, side: Side, value: number): Rect {
  switch (side) {
    case 'left': {
      const x = Math.min(value, r.x + r.w - MIN_RECT_SIZE)
      return { ...r, x, w: r.x + r.w - x }
    }
    case 'right':
      return { ...r, w: Math.max(value - r.x, MIN_RECT_SIZE) }
    case 'top': {
      const y = Math.min(value, r.y + r.h - MIN_RECT_SIZE)
      return { ...r, y, h: r.y + r.h - y }
    }
    case 'bottom':
      return { ...r, h: Math.max(value - r.y, MIN_RECT_SIZE) }
  }
}

/** The dragged edges move by the pointer delta and land on the snap grid. */
function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, snap: number): Rect {
  return handleSides(handle).reduce((resized, side) => {
    const delta = side === 'left' || side === 'right' ? dx : dy
    return withSide(resized, side, snapToGrid(sideValue(r, side) + delta, snap))
  }, r)
}

/** Rectangles of other nets that share a dragged edge of `r`; dragging that cut moves both sides. */
function cutNeighbours(islands: Island[], dragged: Island, r: Rect, handle: Handle): CutNeighbour[] {
  if (dragged.plane) return []
  const eps = 1e-6
  const others = islands.filter((island) => island.net !== dragged.net && !island.plane)
  return handleSides(handle).flatMap((side) =>
    others.flatMap((island) =>
      island.rects.flatMap((other, rectIndex) => {
        const onEdge = Math.abs(sideValue(other, OPPOSITE[side]) - sideValue(r, side)) < eps
        const alongEdge =
          side === 'top' || side === 'bottom'
            ? Math.min(r.x + r.w, other.x + other.w) - Math.max(r.x, other.x)
            : Math.min(r.y + r.h, other.y + other.h) - Math.max(r.y, other.y)
        return onEdge && alongEdge > eps ? [{ net: island.net, rectIndex, rect: other, side: OPPOSITE[side] }] : []
      }),
    ),
  )
}

function handlePosition(r: Rect, handle: Handle): Point {
  const x = handle.includes('w') ? r.x : handle.includes('e') ? r.x + r.w : r.x + r.w / 2
  const y = handle.includes('n') ? r.y : handle.includes('s') ? r.y + r.h : r.y + r.h / 2
  return { x, y }
}

const HANDLE_CURSORS: Record<Handle, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
}

const LEAD_COLOR = '#777777'

const BODY_FILLS: Record<Geometry['shape'], string> = {
  axial: '#9a7444',
  radial: '#3c6ea8',
  smd: '#6b5a3a',
  to92: '#333333',
  to126: '#333333',
  trimmer: '#3c6ea8',
  dip: '#2a2a2a',
  row: '#3c6ea8',
}
const LED_FILL = '#e03131'

export function BodyShape({ geometry, stroke, strokeWidth }: { geometry: Geometry; stroke: string; strokeWidth: number }) {
  const { x, y, w, h } = geometry.body
  const fill = geometry.led ? LED_FILL : BODY_FILLS[geometry.shape]
  const style = { fill, fillOpacity: 0.85, stroke, strokeWidth }
  switch (geometry.shape) {
    case 'radial':
      // A can is round; a box capacitor (length differs from width) is a rounded block.
      if (w !== h) return <rect x={x} y={y} width={w} height={h} rx={0.6} {...style} />
      return <circle cx={x + w / 2} cy={y + h / 2} r={w / 2} {...style} />
    case 'to126':
      // Standing, seen from above: plastic front with the metal back plate on the far side.
      return (
        <>
          <rect x={x} y={y} width={w} height={h} {...style} />
          <rect x={x} y={y} width={w} height={h * 0.25} fill="#b8b8b8" />
        </>
      )
    case 'trimmer':
      return (
        <>
          <rect x={x} y={y} width={w} height={h} rx={0.5} {...style} />
          <circle cx={x + w / 2} cy={y + h / 2} r={Math.min(w, h) * 0.3} fill="#fff" fillOpacity={0.5} />
        </>
      )
    case 'to92': {
      // Seen from above: a circle centred on the legs, cut off by the flat face 0.4 of the depth
      // in front of them (see the to92 geometry in layout.ts).
      const cx = x + w / 2
      const r = Math.min(w / 2, 0.6 * h)
      const halfChord = Math.sqrt(Math.max(0, r * r - (0.4 * h) ** 2))
      const flat = y + h
      return <path d={`M ${cx - halfChord} ${flat} L ${cx + halfChord} ${flat} A ${r} ${r} 0 1 0 ${cx - halfChord} ${flat} Z`} {...style} />
    }
    case 'dip':
      return (
        <>
          <rect x={x} y={y} width={w} height={h} rx={0.3} {...style} />
          <circle cx={x + w / 2} cy={y} r={0.6} fill="#fff" fillOpacity={0.6} />
        </>
      )
    default:
      return <rect x={x} y={y} width={w} height={h} rx={geometry.shape === 'axial' ? 0.8 : 0.3} {...style} />
  }
}

/** The ground plane goes underneath the pads glued onto it. */
const planesFirst = (islands: Island[]) => [...islands.filter((i) => i.plane), ...islands.filter((i) => !i.plane)]

function updateIsland(layout: Layout, net: string, rects: Rect[]): Layout {
  return { ...layout, islands: layout.islands.map((i) => (i.net === net ? { ...i, rects } : i)) }
}

function replaceRect(layout: Layout, net: string, rectIndex: number, rect: Rect): Layout {
  const island = layout.islands.find((i) => i.net === net)!
  return updateIsland(layout, net, island.rects.map((r, k) => (k === rectIndex ? rect : r)))
}

const moveRects = (rects: Rect[], dx: number, dy: number) =>
  rects.map((r) => ({ ...r, x: snapToGrid(r.x + dx, 0), y: snapToGrid(r.y + dy, 0) }))

/** The delta that puts the first rectangle's top-left corner on the snap grid; the rest follow it. */
function gridDelta(rects: Rect[], dx: number, dy: number, snap: number): Point {
  const first = rects[0]
  return { x: snapToGrid(first.x + dx, snap) - first.x, y: snapToGrid(first.y + dy, snap) - first.y }
}

function movePart(current: Placement, moving: MovingPart, dx: number, dy: number): Placement {
  const moved = { ...current, x: moving.placement.x + dx, y: moving.placement.y + dy }
  if (!moving.worldLeadEnds) return moved
  // Leads are stored relative to the body, so keeping their ends in place means re-bending them.
  const leads = Object.fromEntries(Object.entries(moving.worldLeadEnds).map(([pin, end]) => [pin, toLocal(end, moved)]))
  return { ...moved, leads }
}

function moveGroup(layout: Layout, drag: GroupDrag, dx: number, dy: number): Layout {
  const parts = new Map(drag.parts.map((part) => [part.placement.ref, part]))
  const islands = new Map(drag.islands.map((island) => [island.net, island]))
  return {
    placements: layout.placements.map((pl) => {
      const moving = parts.get(pl.ref)
      return moving ? movePart(pl, moving, dx, dy) : pl
    }),
    islands: layout.islands.map((island) => {
      const original = islands.get(island.net)
      return original ? { ...island, rects: moveRects(original.rects, dx, dy) } : island
    }),
  }
}

function rectBetween(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

const isToggleClick = (e: ReactPointerEvent) => e.shiftKey || e.ctrlKey || e.metaKey

export function Canvas(props: Props) {
  const { netlist, layout, onLayoutChange, onBeginEdit, selection, onSelect, snap, isolation, problemNets, fitRequest, layers, tool, moveMode } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const dragChangedRef = useRef(false)
  /** Item to toggle in the selection if the current Shift/Ctrl press ends without dragging. */
  const toggleOnClickRef = useRef<SingleSelection | null>(null)
  const [view, setView] = useState<View>({ scale: 5, ox: 40, oy: 40 })
  const [size, setSize] = useState({ width: 800, height: 600 })
  const [hoveredRef, setHoveredRef] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  // While one part is hovered, the others fade so its leads are easy to follow.
  const partOpacity = (ref: string) => (hoveredRef === null || hoveredRef === ref ? 1 : 0.15)

  useLayoutEffect(() => {
    const svg = svgRef.current!
    const observer = new ResizeObserver(() => {
      const r = svg.getBoundingClientRect()
      setSize({ width: r.width, height: r.height })
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [])

  // React registers wheel listeners as passive, so preventDefault needs a native listener.
  useEffect(() => {
    const svg = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const factor = Math.exp(-e.deltaY * 0.0015)
      setView((v) => {
        const scale = Math.min(Math.max(v.scale * factor, 0.5), 200)
        const k = scale / v.scale
        return { scale, ox: mx - (mx - v.ox) * k, oy: my - (my - v.oy) * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const componentsByRef = useMemo(() => new Map(netlist.components.map((c) => [c.ref, c])), [netlist])
  const islandsByNet = useMemo(() => new Map(layout.islands.map((i) => [i.net, i])), [layout.islands])

  const parts = useMemo(
    () =>
      layout.placements.flatMap((placement) => {
        const component = componentsByRef.get(placement.ref)
        if (!component) return []
        const geometry = componentGeometry(component)
        return [
          {
            component,
            placement,
            geometry,
            leads: analyzeLeads(component, placement, layout.islands, isolation, geometry),
          },
        ]
      }),
    [layout, componentsByRef, isolation],
  )

  useEffect(() => {
    if (fitRequest === 0) return
    const rects = [
      ...layout.islands.flatMap((i) => i.rects),
      ...parts.flatMap((p) => p.leads.map((lead) => ({ x: lead.end.x, y: lead.end.y, w: 0, h: 0 }))),
    ]
    const bounds = boundsOf(rects)
    if (!bounds) return
    const padded = inflate(bounds, 5)
    const { width, height } = svgRef.current!.getBoundingClientRect()
    const scale = Math.min(width / padded.w, height / padded.h)
    setView({
      scale,
      ox: (width - padded.w * scale) / 2 - padded.x * scale,
      oy: (height - padded.h * scale) / 2 - padded.y * scale,
    })
    // Only refit when explicitly requested, not on every layout change.
  }, [fitRequest])

  const snapValue = (v: number) => snapToGrid(v, snap)

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale }
  }

  const beginDrag = (e: ReactPointerEvent, drag: Drag) => {
    dragRef.current = drag
    dragChangedRef.current = false
    toggleOnClickRef.current = null
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  const onBackgroundPointerDown = (e: ReactPointerEvent) => {
    if (e.button === 0 && tool === 'select') {
      beginDrag(e, { kind: 'marquee', start: toWorld(e), startX: e.clientX, startY: e.clientY, additive: isToggleClick(e) })
      return
    }
    if (e.button === 0) onSelect(null)
    beginDrag(e, { kind: 'pan', startX: e.clientX, startY: e.clientY, view })
  }

  const movingPart = (ref: string, withLeads: boolean): MovingPart => {
    const part = parts.find((p) => p.component.ref === ref)!
    if (withLeads) return { placement: part.placement }
    const worldLeadEnds = Object.fromEntries(part.component.pins.map((pin, k) => [pin.number, part.leads[k].end]))
    return { placement: part.placement, worldLeadEnds }
  }

  /**
   * Pressing an item of a multi-selection drags the whole group; otherwise the item alone is
   * selected and `singleDrag` starts. Shift+drag always takes the leads along, whatever the move
   * mode. A Shift/Ctrl press that ends without dragging toggles the item in the selection instead.
   */
  const onItemPointerDown = (e: ReactPointerEvent, item: SingleSelection, singleDrag: (withLeads: boolean) => Drag) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const toggling = isToggleClick(e)
    const withLeads = e.shiftKey || moveMode === 'part'
    if (selection?.kind === 'multi' && isSelected(selection, item)) {
      const { refs, nets } = selection
      beginDrag(e, {
        kind: 'group',
        start: toWorld(e),
        parts: parts.filter((p) => refs.includes(p.component.ref)).map((p) => movingPart(p.component.ref, withLeads)),
        islands: layout.islands.filter((island) => nets.includes(island.net)),
        pressed: item,
      })
    } else {
      if (!toggling) onSelect(item)
      beginDrag(e, singleDrag(withLeads))
    }
    if (toggling) toggleOnClickRef.current = item
  }

  // Non-left buttons fall through to the background handler, so middle-drag always pans.
  const onIslandPointerDown = (e: ReactPointerEvent, island: Island, rectIndex: number) =>
    onItemPointerDown(e, { kind: 'island', net: island.net, rectIndex }, () => ({
      kind: 'island',
      net: island.net,
      start: toWorld(e),
      rects: island.rects,
    }))

  const onPartPointerDown = (e: ReactPointerEvent, ref: string) =>
    onItemPointerDown(e, { kind: 'part', ref }, (withLeads) => ({ kind: 'part', start: toWorld(e), part: movingPart(ref, withLeads) }))

  const onHandlePointerDown = (e: ReactPointerEvent, island: Island, rectIndex: number, handle: Handle) => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect({ kind: 'island', net: island.net, rectIndex })
    const rect = island.rects[rectIndex]
    const neighbours = cutNeighbours(layout.islands, island, rect, handle)
    beginDrag(e, { kind: 'resize', net: island.net, rectIndex, handle, start: toWorld(e), rect, neighbours })
  }

  const onLeadPointerDown = (e: ReactPointerEvent, placement: Placement, pin: string, origin: Point) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (isToggleClick(e)) {
      onSelect(toggleSelected(selection, { kind: 'part', ref: placement.ref }))
      return
    }
    onSelect({ kind: 'part', ref: placement.ref })
    beginDrag(e, { kind: 'lead', pin, start: toWorld(e), origin, placement })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'pan') {
      setView({ ...drag.view, ox: drag.view.ox + e.clientX - drag.startX, oy: drag.view.oy + e.clientY - drag.startY })
      return
    }
    if (drag.kind === 'marquee') {
      setMarquee(rectBetween(drag.start, toWorld(e)))
      return
    }
    const p = toWorld(e)
    const rawDx = p.x - drag.start.x
    const rawDy = p.y - drag.start.y
    if (!dragChangedRef.current) {
      // Island edges snap to the grid, not by the delta, so the slightest jitter could move an
      // off-grid island: a press must move a few pixels before it counts as a drag.
      if (Math.hypot(rawDx, rawDy) * view.scale <= CLICK_TOLERANCE_PX) return
      dragChangedRef.current = true
      onBeginEdit()
    }
    const dx = snapValue(rawDx)
    const dy = snapValue(rawDy)
    if (drag.kind === 'island') {
      const delta = gridDelta(drag.rects, rawDx, rawDy, snap)
      const moved = moveRects(drag.rects, delta.x, delta.y)
      onLayoutChange((l) => updateIsland(l, drag.net, moved))
    } else if (drag.kind === 'resize') {
      const resized = resizeRect(drag.rect, drag.handle, rawDx, rawDy, snap)
      onLayoutChange((l) =>
        drag.neighbours.reduce(
          (next, n) => replaceRect(next, n.net, n.rectIndex, withSide(n.rect, n.side, sideValue(resized, OPPOSITE[n.side]))),
          replaceRect(l, drag.net, drag.rectIndex, resized),
        ),
      )
    } else if (drag.kind === 'lead') {
      // Stored relative to the body so the bent lead follows the component.
      const end = toLocal({ x: drag.origin.x + dx, y: drag.origin.y + dy }, drag.placement)
      onLayoutChange((l) => ({
        ...l,
        placements: l.placements.map((pl) =>
          pl.ref === drag.placement.ref ? { ...pl, leads: { ...pl.leads, [drag.pin]: end } } : pl,
        ),
      }))
    } else if (drag.kind === 'part') {
      onLayoutChange((l) => ({
        ...l,
        placements: l.placements.map((pl) => (pl.ref === drag.part.placement.ref ? movePart(pl, drag.part, dx, dy) : pl)),
      }))
    } else {
      // Parts move by the same delta as the islands, so they stay where they sit on the copper.
      const delta = drag.islands.length > 0 ? gridDelta(drag.islands[0].rects, rawDx, rawDy, snap) : { x: dx, y: dy }
      onLayoutChange((l) => moveGroup(l, drag, delta.x, delta.y))
    }
  }

  const finishMarquee = (drag: MarqueeDrag, e: ReactPointerEvent) => {
    setMarquee(null)
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) {
      if (!drag.additive) onSelect(null)
      return
    }
    const area = rectBetween(drag.start, toWorld(e))
    const refs = parts
      .filter(({ geometry, placement }) => rectsOverlap(bodyBounds(geometry, placement), area))
      .map(({ component }) => component.ref)
    const nets = layout.islands.filter((island) => island.rects.some((r) => rectsOverlap(r, area))).map((i) => i.net)
    onSelect(drag.additive ? addToSelection(selection, refs, nets) : selectionOf(refs, nets))
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    const toggleOnClick = toggleOnClickRef.current
    dragRef.current = null
    toggleOnClickRef.current = null
    svgRef.current!.releasePointerCapture(e.pointerId)
    if (drag?.kind === 'marquee') finishMarquee(drag, e)
    else if (toggleOnClick && !dragChangedRef.current) onSelect(toggleSelected(selection, toggleOnClick))
    // A click without dragging on an item of a multi-selection selects just that item.
    else if (drag?.kind === 'group' && !dragChangedRef.current) onSelect(drag.pressed)
  }

  // Sizes that should stay constant on screen, expressed in mm.
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale)
  const visible = {
    x: -view.ox / view.scale,
    y: -view.oy / view.scale,
    w: size.width / view.scale,
    h: size.height / view.scale,
  }
  const selectedIsland = selection?.kind === 'island' ? islandsByNet.get(selection.net) : undefined
  const selectedRectIndex = selection?.kind === 'island' ? selection.rectIndex : -1
  const highlightedNets = new Set(selectedNets(selection))
  const highlightedRefs = new Set(selectedRefs(selection))

  return (
    <svg
      ref={svgRef}
      className={tool === 'pan' ? `${layerClasses(layers)} tool-pan` : layerClasses(layers)}
      style={layerOpacities(layers)}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <defs>
        <pattern id="grid-minor" width={pitch} height={pitch} patternUnits="userSpaceOnUse">
          <path
            d={`M ${pitch} 0 L 0 0 0 ${pitch}`}
            fill="none"
            stroke="#d0d4d9"
            strokeWidth={px}
            strokeDasharray={`${2 * px} ${3 * px}`}
          />
        </pattern>
        <pattern id="grid-major" width={5 * pitch} height={5 * pitch} patternUnits="userSpaceOnUse">
          <path d={`M ${5 * pitch} 0 L 0 0 0 ${5 * pitch}`} fill="none" stroke="#c4c9cf" strokeWidth={px} />
        </pattern>
      </defs>
      <g transform={`translate(${view.ox} ${view.oy}) scale(${view.scale})`}>
        <g className="grid">
          <rect x={visible.x} y={visible.y} width={visible.w} height={visible.h} fill="url(#grid-minor)" />
          <rect x={visible.x} y={visible.y} width={visible.w} height={visible.h} fill="url(#grid-major)" />
          {/* Origin axes: x = 0 and y = 0 */}
          <line x1={visible.x} y1={0} x2={visible.x + visible.w} y2={0} stroke="#8b96a3" strokeWidth={px} />
          <line x1={0} y1={visible.y} x2={0} y2={visible.y + visible.h} stroke="#8b96a3" strokeWidth={px} />
        </g>

        {planesFirst(layout.islands).map((island) => {
          const violating = problemNets.has(island.net)
          const selected = highlightedNets.has(island.net)
          return (
            <g key={island.net} className="island">
              {/* The copper left after cutting; the rectangles themselves only catch the pointer. */}
              <path
                d={outlinePath(island.rects, isolation / 2)}
                fill={island.plane ? (selected ? '#f3d6b4' : '#ecc9a4') : selected ? '#f0a860' : '#d9945a'}
                fillRule="evenodd"
                stroke={violating ? '#e02020' : selected ? '#7a3d00' : '#9c5a24'}
                strokeWidth={(violating ? 3 : selected ? 2 : 1) * px}
                pointerEvents="none"
              />
              {island.rects.map((r, k) => (
                <rect
                  key={k}
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  className="island-rect"
                  fill="transparent"
                  onPointerDown={(e) => onIslandPointerDown(e, island, k)}
                />
              ))}
              <text x={island.rects[0].x + 0.5} y={island.rects[0].y + 1.6} className="net-label">
                {island.net}
              </text>
            </g>
          )
        })}

        {parts.flatMap(({ component, leads }) =>
          leads.map((lead, k) => {
            const island = islandsByNet.get(lead.net)
            if (!island || lead.status === 'ok') return null
            const target = nearestPointOnRects(island.rects, lead.end)
            return (
              <line
                key={`${component.ref}.${k}`}
                className="ratsnest"
                x1={lead.end.x}
                y1={lead.end.y}
                x2={target.x}
                y2={target.y}
                stroke={PIN_COLORS[lead.status]}
                opacity={partOpacity(component.ref) * layers.leads.opacity}
                strokeWidth={1.5 * px}
                strokeDasharray={`${4 * px} ${3 * px}`}
                pointerEvents="none"
              />
            )
          }),
        )}

        {parts.map(({ component, placement, geometry, leads }) => {
          const selected = highlightedRefs.has(component.ref)
          const { body } = geometry
          const center = toWorldPoint({ x: body.x + body.w / 2, y: body.y + body.h / 2 }, placement)
          const rotatedHeight = bodyBounds(geometry, placement).h
          return (
            <g
              key={component.ref}
              className="part"
              opacity={partOpacity(component.ref) * layers.parts.opacity}
              onPointerDown={(e) => onPartPointerDown(e, component.ref)}
              onPointerEnter={() => setHoveredRef(component.ref)}
              onPointerLeave={() => setHoveredRef((ref) => (ref === component.ref ? null : ref))}
            >
              {leads.map((lead, k) => (
                <line
                  key={k}
                  className="lead"
                  x1={lead.anchor.x}
                  y1={lead.anchor.y}
                  x2={lead.end.x}
                  y2={lead.end.y}
                  stroke={LEAD_COLOR}
                  strokeWidth={0.35}
                  strokeLinecap="round"
                />
              ))}
              <g transform={`translate(${placement.x} ${placement.y}) rotate(${placement.rotation})`}>
                <BodyShape geometry={geometry} stroke={selected ? '#2a7fff' : '#111'} strokeWidth={(selected ? 2.5 : 1) * px} />
              </g>
              {leads.map((lead, k) => {
                const pin = component.pins[k]
                const color = PIN_COLORS[lead.status]
                const { x, y } = lead.end
                return (
                  <g key={k} className="lead-end" onPointerDown={(e) => onLeadPointerDown(e, placement, pin.number, lead.end)}>
                    <title>
                      {`${component.ref}.${pin.number}: ${pin.net || '(no net)'} — drag to bend the lead`}
                    </title>
                    {/* Square marks pin 1. */}
                    {k === 0 ? (
                      <rect x={x - 0.5} y={y - 0.5} width={1} height={1} fill={color} />
                    ) : (
                      <circle cx={x} cy={y} r={0.5} fill={color} />
                    )}
                    <circle cx={x} cy={y} r={Math.max(0.9, 7 * px)} fill="transparent" />
                  </g>
                )
              })}
              <text x={center.x} y={center.y + 0.45} className="part-ref">
                {component.ref}
              </text>
              {component.value && (
                <text x={center.x} y={center.y + rotatedHeight / 2 + 1.3} className="part-value">
                  {component.value}
                </text>
              )}
            </g>
          )
        })}

        {/* Handles only on the clicked rectangle: optimized islands can consist of hundreds. */}
        {selectedIsland?.rects.map((r, k) => k === selectedRectIndex && (
          <g key={k}>
            {selectedIsland.rects.length > 1 && (
              <rect
                x={r.x}
                y={r.y}
                width={r.w}
                height={r.h}
                fill="none"
                stroke="#2a7fff"
                strokeWidth={px}
                strokeDasharray={`${4 * px} ${3 * px}`}
                pointerEvents="none"
              />
            )}
            {HANDLES.map((handle) => {
              const p = handlePosition(r, handle)
              return (
                <rect
                  key={handle}
                  x={p.x - 4 * px}
                  y={p.y - 4 * px}
                  width={8 * px}
                  height={8 * px}
                  fill="#fff"
                  stroke="#2a7fff"
                  strokeWidth={px}
                  style={{ cursor: HANDLE_CURSORS[handle] }}
                  onPointerDown={(e) => onHandlePointerDown(e, selectedIsland, k, handle)}
                />
              )
            })}
          </g>
        ))}

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
      <Rulers view={view} width={size.width} height={size.height} pitch={pitch} />
    </svg>
  )
}

const RULER_PX = 18

/** Tick positions (mm) of one ruler: every grid pitch inside [from, to]. */
function rulerTicks(from: number, to: number, pitch: number): number[] {
  const ticks: number[] = []
  for (let k = Math.ceil(from / pitch); k * pitch <= to; k++) ticks.push(k * pitch)
  return ticks
}

/**
 * Millimetre rulers along the top and left edge, in screen space so they stay put while the
 * board pans under them. Labels sit on the solid (every fifth) grid lines.
 */
function Rulers({ view, width, height, pitch }: { view: View; width: number; height: number; pitch: number }) {
  const toScreenX = (mm: number) => view.ox + mm * view.scale
  const toScreenY = (mm: number) => view.oy + mm * view.scale
  const isMajor = (mm: number) => Math.abs(mm / (5 * pitch) - Math.round(mm / (5 * pitch))) < 1e-6
  const label = (mm: number) => String(Math.round(mm * 100) / 100)
  const xTicks = rulerTicks(-view.ox / view.scale, (width - view.ox) / view.scale, pitch)
  const yTicks = rulerTicks(-view.oy / view.scale, (height - view.oy) / view.scale, pitch)
  return (
    <g className="ruler" pointerEvents="none">
      <rect x={0} y={0} width={width} height={RULER_PX} />
      <rect x={0} y={0} width={RULER_PX} height={height} />
      {xTicks.map((mm) => {
        const x = toScreenX(mm)
        if (x < RULER_PX) return null
        return (
          <g key={`x${mm}`}>
            <line x1={x} y1={RULER_PX} x2={x} y2={RULER_PX - (isMajor(mm) ? 8 : 4)} />
            {isMajor(mm) && <text x={x + 2} y={9}>{label(mm)}</text>}
          </g>
        )
      })}
      {yTicks.map((mm) => {
        const y = toScreenY(mm)
        if (y < RULER_PX) return null
        return (
          <g key={`y${mm}`}>
            <line x1={RULER_PX} y1={y} x2={RULER_PX - (isMajor(mm) ? 8 : 4)} y2={y} />
            {isMajor(mm) && (
              <text x={9} y={y + 2} transform={`rotate(-90 9 ${y + 2})`}>{label(mm)}</text>
            )}
          </g>
        )
      })}
      <text x={3} y={12} className="ruler-unit">mm</text>
    </g>
  )
}
