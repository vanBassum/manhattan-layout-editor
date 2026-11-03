import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, inflate, nearestPointOnRects, outlinePath, rectBetween, rectsOverlap, snapToGrid } from './geometry'
import { analyzeLeads, bodyBounds, toWorld as toWorldPoint, type MovingPart, type PinStatus } from './layout'
import { cutNeighbours, findCuts, type Cut, type Side } from './cuts'
import { draggedLayout, type LayoutDrag } from './layoutDrag'
import { islandEdges, moveIslandEdge, type IslandEdge } from './raster'
import { addToSelection, isSelected, isToggleClick, selectedNets, selectedRefs, selectionOf, toggleSelected, type SingleSelection } from './selection'
import type { BuiltNetlist, Geometry, Island, Layout, Placement, Point, Rect, Selection } from './types'
import { layerClasses, layerOpacities, type Layers } from './ui/layers'
import { gridPitch, gridPitches, Rulers, useViewport, ViewportGrid, type View } from './ui/viewport'

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Select: dragging empty space draws a selection rectangle. Pan: it moves the view. */
export type Tool = 'select' | 'pan'

/** The tab the + on an island edge pulls out: how far it sticks out, and how wide it is along the edge. */
const TAB_DEPTH_MM = 2.5
const TAB_WIDTH_MM = 2.5

/** Part: the part moves with its bent leads. Body: lead ends stay soldered where they are. */
export type MoveMode = 'part' | 'body'

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: Point; startX: number; startY: number; additive: boolean }
  /** `pressed`: the item of a multi-selection that started a group drag. */
  | { kind: 'edit'; edit: LayoutDrag; start: Point; pressed?: SingleSelection }

type MarqueeDrag = Extract<Drag, { kind: 'marquee' }>

/** A press that moves less than this (screen pixels) is a click, not a selection rectangle. */
const CLICK_TOLERANCE_PX = 3
const HANDLES: Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

const PIN_COLORS: Record<PinStatus, string> = {
  ok: '#2e9e44',
  open: '#e0a000',
  short: '#e02020',
  unused: '#888888',
}

/** The finest grid pitch in mm. */
const FINE_GRID_MM = 1
export const DEFAULT_PCB_GRID_LINES_PER_MAJOR = 5

interface Props {
  netlist: BuiltNetlist
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
  /** Resize handles on the clicked rectangle of the selected island. */
  rectHandles: boolean
  /** Fine grid steps (1 mm) between two solid grid lines. */
  gridLinesPerMajor: number
}

function handleSides(handle: Handle): Side[] {
  const sides: Side[] = []
  if (handle.includes('w')) sides.push('left')
  if (handle.includes('e')) sides.push('right')
  if (handle.includes('n')) sides.push('top')
  if (handle.includes('s')) sides.push('bottom')
  return sides
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
      // A standing multiturn trimmer (3296W) is a narrow block with its brass screw at the pin 3 end.
      if (w !== h) {
        const screw = Math.min(w, h) * 0.3
        return (
          <>
            <rect x={x} y={y} width={w} height={h} rx={0.3} {...style} />
            <circle cx={x + w - screw - 0.4} cy={y + h / 2} r={screw} fill="#c9a227" stroke="#7a6010" strokeWidth={strokeWidth} />
          </>
        )
      }
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
      return (
        <>
          <rect x={x} y={y} width={w} height={h} rx={geometry.shape === 'axial' ? 0.8 : 0.3} {...style} />
          {geometry.band && <CathodeBand geometry={geometry} />}
        </>
      )
  }
}

/** A light band across the body at the end where pin 1 (the cathode) leaves it. */
function CathodeBand({ geometry }: { geometry: Geometry }) {
  const { x, y, w, h } = geometry.body
  const pin1 = geometry.anchors[0]
  const alongX = w >= h
  const thickness = Math.max(alongX ? w : h, 1) * 0.16
  // Inset from the end so the band sits on the body, not on its rounded corner.
  const inset = (alongX ? w : h) * 0.08
  if (alongX) {
    const bx = pin1.x < x + w / 2 ? x + inset : x + w - inset - thickness
    return <rect className="cathode-band" x={bx} y={y} width={thickness} height={h} />
  }
  const by = pin1.y < y + h / 2 ? y + inset : y + h - inset - thickness
  return <rect className="cathode-band" x={x} y={by} width={w} height={thickness} />
}

/** The ground plane goes underneath the pads glued onto it. */
const planesFirst = (islands: Island[]) => [...islands.filter((i) => i.plane), ...islands.filter((i) => !i.plane)]

export function Canvas(props: Props) {
  const { netlist, layout, onLayoutChange, onBeginEdit, selection, onSelect, snap, isolation, problemNets, fitRequest, layers, tool, moveMode, rectHandles, gridLinesPerMajor } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const dragChangedRef = useRef(false)
  /** Item to toggle in the selection if the current Shift/Ctrl press ends without dragging. */
  const toggleOnClickRef = useRef<SingleSelection | null>(null)
  const { view, setView, size, fitTo } = useViewport(svgRef)
  const [hoveredRef, setHoveredRef] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  /** "net:index" of the outline edge under the pointer; that edge shows its +. */
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  // While one part is hovered, the others fade so its leads are easy to follow.
  const partOpacity = (ref: string) => (hoveredRef === null || hoveredRef === ref ? 1 : 0.15)

  const componentsByRef = useMemo(() => new Map(netlist.components.map((c) => [c.ref, c])), [netlist])
  const islandsByNet = useMemo(() => new Map(layout.islands.map((i) => [i.net, i])), [layout.islands])
  const cuts = useMemo(() => findCuts(layout.islands), [layout.islands])

  const parts = useMemo(
    () =>
      layout.placements.flatMap((placement) => {
        const component = componentsByRef.get(placement.ref)
        if (!component) return []
        return [
          {
            component,
            placement,
            geometry: component.geometry,
            leads: analyzeLeads(component, placement, layout.islands, isolation),
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
    if (bounds) fitTo(inflate(bounds, 5))
    // Only refit when explicitly requested, not on every layout change.
  }, [fitRequest])

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
  const onItemPointerDown = (e: ReactPointerEvent, item: SingleSelection, singleDrag: (withLeads: boolean) => LayoutDrag) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const toggling = isToggleClick(e)
    const withLeads = e.shiftKey || moveMode === 'part'
    if (selection?.kind === 'multi' && isSelected(selection, item)) {
      const { refs, nets } = selection
      const group: LayoutDrag = {
        kind: 'group',
        parts: parts.filter((p) => refs.includes(p.component.ref)).map((p) => movingPart(p.component.ref, withLeads)),
        islands: layout.islands.filter((island) => nets.includes(island.net)),
      }
      beginDrag(e, { kind: 'edit', edit: group, start: toWorld(e), pressed: item })
    } else {
      if (!toggling) onSelect(item)
      beginDrag(e, { kind: 'edit', edit: singleDrag(withLeads), start: toWorld(e) })
    }
    if (toggling) toggleOnClickRef.current = item
  }

  // Non-left buttons fall through to the background handler, so middle-drag always pans.
  const onIslandPointerDown = (e: ReactPointerEvent, island: Island, rectIndex: number) =>
    onItemPointerDown(e, { kind: 'island', net: island.net, rectIndex }, () => ({ kind: 'island', net: island.net, rects: island.rects }))

  const onPartPointerDown = (e: ReactPointerEvent, ref: string) =>
    onItemPointerDown(e, { kind: 'part', ref }, (withLeads) => ({ kind: 'part', part: movingPart(ref, withLeads) }))

  const onHandlePointerDown = (e: ReactPointerEvent, island: Island, rectIndex: number, handle: Handle) => {
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect({ kind: 'island', net: island.net, rectIndex })
    const rect = island.rects[rectIndex]
    const sides = handleSides(handle)
    const neighbours = cutNeighbours(layout.islands, island, rect, sides)
    const edit: LayoutDrag = { kind: 'resize', net: island.net, rectIndex, sides, rect, neighbours }
    beginDrag(e, { kind: 'edit', edit, start: toWorld(e) })
  }

  const onCutPointerDown = (e: ReactPointerEvent, cut: Cut) => {
    if (e.button !== 0) return
    e.stopPropagation()
    beginDrag(e, { kind: 'edit', edit: { kind: 'cut', cut, islands: layout.islands }, start: toWorld(e) })
  }

  const onEdgePointerDown = (e: ReactPointerEvent, net: string, edge: IslandEdge) => {
    if (e.button !== 0) return
    e.stopPropagation()
    beginDrag(e, { kind: 'edit', edit: { kind: 'edge', net, edge, islands: layout.islands }, start: toWorld(e) })
  }

  /** Pulls a tab out of the middle of `edge`; dragging the edge itself moves all of it. */
  const onGrowPointerDown = (e: ReactPointerEvent, net: string, edge: IslandEdge) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const from = Math.max(edge.from, snapToGrid((edge.from + edge.to - TAB_WIDTH_MM) / 2, snap))
    const tab = { ...edge, from, to: Math.min(edge.to, from + TAB_WIDTH_MM) }
    const target = edge.inside === 'low' ? edge.at + TAB_DEPTH_MM : edge.at - TAB_DEPTH_MM
    onBeginEdit()
    onLayoutChange((l) => ({ ...l, islands: moveIslandEdge(l.islands, net, tab, target) }))
    setHoveredEdge(null)
  }

  const onLeadPointerDown = (e: ReactPointerEvent, placement: Placement, pin: string, origin: Point) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (isToggleClick(e)) {
      onSelect(toggleSelected(selection, { kind: 'part', ref: placement.ref }))
      return
    }
    onSelect({ kind: 'part', ref: placement.ref })
    beginDrag(e, { kind: 'edit', edit: { kind: 'lead', ref: placement.ref, pin, origin }, start: toWorld(e) })
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
    const delta = { x: p.x - drag.start.x, y: p.y - drag.start.y }
    if (!dragChangedRef.current) {
      // Island edges snap to the grid, not by the delta, so the slightest jitter could move an
      // off-grid island: a press must move a few pixels before it counts as a drag.
      if (Math.hypot(delta.x, delta.y) * view.scale <= CLICK_TOLERANCE_PX) return
      dragChangedRef.current = true
      onBeginEdit()
    }
    onLayoutChange((l) => draggedLayout(l, drag.edit, delta, snap))
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
    else if (drag?.kind === 'edit' && drag.pressed && !dragChangedRef.current) onSelect(drag.pressed)
  }

  // Sizes that should stay constant on screen, expressed in mm.
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale, gridPitches(FINE_GRID_MM, gridLinesPerMajor))
  const selectedIsland = selection?.kind === 'island' ? islandsByNet.get(selection.net) : undefined
  const selectedRectIndex = selection?.kind === 'island' ? selection.rectIndex : -1
  const highlightedNets = new Set(selectedNets(selection))
  const selectedEdges = selectedIsland && !selectedIsland.plane ? islandEdges(layout.islands, selectedIsland.net) : []
  const highlightedRefs = new Set(selectedRefs(selection))

  return (
    <svg
      ref={svgRef}
      className={['canvas', ...layerClasses(layers, { dimFaint: true }), tool === 'pan' && 'tool-pan'].filter(Boolean).join(' ')}
      style={layerOpacities(layers)}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <g transform={`translate(${view.ox} ${view.oy}) scale(${view.scale})`}>
        <ViewportGrid view={view} size={size} pitch={pitch} linesPerMajor={gridLinesPerMajor} />

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

        {/* Dragging a cut moves the islands on both sides of it, the way a knife-cut board is edited. */}
        {tool === 'select' && (
          <g className="cuts">
            {cuts.map((cut) => {
              const [x1, y1, x2, y2] = cut.axis === 'x' ? [cut.at, cut.from, cut.at, cut.to] : [cut.from, cut.at, cut.to, cut.at]
              return (
                <line
                  key={`${cut.axis}${cut.at}:${cut.from}`}
                  className={`cut cut-${cut.axis}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  strokeWidth={6 * px}
                  onPointerDown={(e) => onCutPointerDown(e, cut)}
                />
              )
            })}
          </g>
        )}

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

        {selectedEdges.map((edge, k) => {
          const net = selectedIsland!.net
          const [x1, y1, x2, y2] = edge.axis === 'x' ? [edge.at, edge.from, edge.at, edge.to] : [edge.from, edge.at, edge.to, edge.at]
          // The + sits just outside the island, touching the edge's hit area so the pointer can reach it.
          const outward = (edge.inside === 'low' ? 1 : -1) * 9 * px
          const mid = (edge.from + edge.to) / 2
          const plus = edge.axis === 'x' ? { x: edge.at + outward, y: mid } : { x: mid, y: edge.at + outward }
          const hoverKey = `${net}:${k}`
          return (
            <g
              key={k}
              className={hoveredEdge === hoverKey ? 'island-edge hovered' : 'island-edge'}
              onPointerEnter={() => setHoveredEdge(hoverKey)}
              onPointerLeave={() => setHoveredEdge((key) => (key === hoverKey ? null : key))}
            >
              <line
                className={edge.axis === 'x' ? 'cut-x' : 'cut-y'}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                strokeWidth={6 * px}
                onPointerDown={(e) => onEdgePointerDown(e, net, edge)}
              />
              {hoveredEdge === hoverKey && (
                <g className="grow-button" onPointerDown={(e) => onGrowPointerDown(e, net, edge)}>
                  <title>Add a {TAB_WIDTH_MM} × {TAB_DEPTH_MM} mm tab here; drag the edge to move all of it</title>
                  <circle cx={plus.x} cy={plus.y} r={7 * px} strokeWidth={px} />
                  <path
                    d={`M${plus.x - 3.5 * px} ${plus.y}h${7 * px}M${plus.x} ${plus.y - 3.5 * px}v${7 * px}`}
                    strokeWidth={1.5 * px}
                  />
                </g>
              )}
            </g>
          )
        })}

        {/* Handles only on the clicked rectangle: optimized islands can consist of hundreds. */}
        {rectHandles && selectedIsland?.rects.map((r, k) => k === selectedRectIndex && (
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
      <Rulers view={view} size={size} pitch={pitch} linesPerMajor={gridLinesPerMajor} />
    </svg>
  )
}
