import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, nearestPointOnRects, outlinePath, rectBetween, rectsOverlap, snapToGrid } from '../../model/geometry'
import { analyzeLeads, bodyBounds, toWorld as toWorldPoint, type LeadInfo, type MovingPart, type PinStatus } from '../../model/layout'
import { cutNeighbours, findCuts, type Cut, type Side } from '../../model/cuts'
import { draggedLayout, type LayoutDrag } from '../../model/layoutDrag'
import { islandEdges, moveIslandEdge, type IslandEdge } from '../../model/raster'
import { addToSelection, isSelected, isToggleClick, selectedNets, selectedRefs, selectionOf, toggleSelected, type SingleSelection } from '../../model/selection'
import type { BuiltComponent, BuiltNetlist, Geometry, Island, Layout, Placement, Point, Rect, Selection } from '../../model/types'
import { layerClasses, layerOpacities, type Layers } from '../layers'
import {
  CLICK_TOLERANCE_PX,
  gridPitch,
  gridPitches,
  pannedView,
  Rulers,
  screenToWorld,
  useViewport,
  ViewportGrid,
  type MarqueeDrag,
  type PanDrag,
} from '../viewport'
import { BodyShape, COPPER_COLOR, LEAD_COLOR } from './partDrawing'

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** Select: dragging empty space draws a selection rectangle. Pan: it moves the view. */
export type Tool = 'select' | 'pan'

/** The tab the + on an island edge pulls out: how far it sticks out, and how wide it is along the edge. */
const TAB_DEPTH_MM = 2.5
const TAB_WIDTH_MM = 2.5

/** Part: the part moves with its bent leads. Body: lead ends stay soldered where they are. */
export type MoveMode = 'part' | 'body'

type Drag =
  | PanDrag
  | MarqueeDrag
  /**
   * `pressed`: the item whose press started the drag. A press that ends without moving toggles it
   * in the selection when `toggle` is set (Shift/Ctrl), and otherwise selects it alone after a
   * group drag.
   */
  | { kind: 'edit'; edit: LayoutDrag; start: Point; moved: boolean; pressed?: SingleSelection; toggle: boolean }

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

/** The ground plane goes underneath the pads glued onto it. */
const planesFirst = (islands: Island[]) => [...islands.filter((i) => i.plane), ...islands.filter((i) => !i.plane)]

/** A plane is paler copper, selected copper is lighter, and a problem net gets a thick red outline. */
function islandStyle(plane: boolean, selected: boolean, violating: boolean): { fill: string; stroke: string; strokeWidthPx: number } {
  const fill = plane ? (selected ? '#f3d6b4' : '#ecc9a4') : (selected ? '#f0a860' : COPPER_COLOR)
  if (violating) return { fill, stroke: '#e02020', strokeWidthPx: 3 }
  if (selected) return { fill, stroke: '#7a3d00', strokeWidthPx: 2 }
  return { fill, stroke: '#9c5a24', strokeWidthPx: 1 }
}

/** A part as drawn: its placement and where each of its leads ends up. */
interface DrawnPart {
  component: BuiltComponent
  placement: Placement
  geometry: Geometry
  leads: LeadInfo[]
}

interface LayoutPartProps {
  part: DrawnPart
  selected: boolean
  opacity: number
  /** One screen pixel in mm. */
  px: number
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
  onLeadPointerDown: (e: ReactPointerEvent, pin: string, end: Point) => void
}

function LayoutPart({ part, selected, opacity, px, onPointerDown, onPointerEnter, onPointerLeave, onLeadPointerDown }: LayoutPartProps) {
  const { component, placement, geometry, leads } = part
  const { body } = geometry
  const center = toWorldPoint({ x: body.x + body.w / 2, y: body.y + body.h / 2 }, placement)
  const rotatedHeight = bodyBounds(geometry, placement).h
  return (
    <g className="part" opacity={opacity} onPointerDown={onPointerDown} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
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
          <g key={k} className="lead-end" onPointerDown={(e) => onLeadPointerDown(e, pin.number, lead.end)}>
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
}

interface IslandEdgeHandleProps {
  edge: IslandEdge
  /** One screen pixel in mm. */
  px: number
  /** A hovered edge shows the + that pulls out a tab. */
  hovered: boolean
  onPointerEnter: () => void
  onPointerLeave: () => void
  onEdgePointerDown: (e: ReactPointerEvent) => void
  onGrowPointerDown: (e: ReactPointerEvent) => void
}

function IslandEdgeHandle({ edge, px, hovered, onPointerEnter, onPointerLeave, onEdgePointerDown, onGrowPointerDown }: IslandEdgeHandleProps) {
  const [x1, y1, x2, y2] = edge.axis === 'x' ? [edge.at, edge.from, edge.at, edge.to] : [edge.from, edge.at, edge.to, edge.at]
  // The + sits just outside the island, touching the edge's hit area so the pointer can reach it.
  const outward = (edge.inside === 'low' ? 1 : -1) * 9 * px
  const mid = (edge.from + edge.to) / 2
  const plus = edge.axis === 'x' ? { x: edge.at + outward, y: mid } : { x: mid, y: edge.at + outward }
  return (
    <g className={hovered ? 'island-edge hovered' : 'island-edge'} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <line
        className={edge.axis === 'x' ? 'cut-x' : 'cut-y'}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        strokeWidth={6 * px}
        onPointerDown={onEdgePointerDown}
      />
      {hovered && (
        <g className="grow-button" onPointerDown={onGrowPointerDown}>
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
}

interface RectHandlesProps {
  rect: Rect
  /** Outline the rectangle, to tell it apart from the other rectangles of its island. */
  outlined: boolean
  /** One screen pixel in mm. */
  px: number
  onHandlePointerDown: (e: ReactPointerEvent, handle: Handle) => void
}

function RectHandles({ rect, outlined, px, onHandlePointerDown }: RectHandlesProps) {
  return (
    <g>
      {outlined && (
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          fill="none"
          stroke="#2a7fff"
          strokeWidth={px}
          strokeDasharray={`${4 * px} ${3 * px}`}
          pointerEvents="none"
        />
      )}
      {HANDLES.map((handle) => {
        const p = handlePosition(rect, handle)
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
            onPointerDown={(e) => onHandlePointerDown(e, handle)}
          />
        )
      })}
    </g>
  )
}

export function Canvas(props: Props) {
  const { netlist, layout, onLayoutChange, onBeginEdit, selection, onSelect, snap, isolation, problemNets, fitRequest, layers, tool, moveMode, rectHandles, gridLinesPerMajor } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
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

  const { view, setView, size } = useViewport(svgRef, fitRequest, () =>
    boundsOf([
      ...layout.islands.flatMap((i) => i.rects),
      ...parts.flatMap((p) => p.leads.map((lead) => ({ x: lead.end.x, y: lead.end.y, w: 0, h: 0 }))),
    ]),
  )

  const toWorld = (e: { clientX: number; clientY: number }): Point => screenToWorld(svgRef.current!, view, e)

  const beginDrag = (e: ReactPointerEvent, drag: Drag) => {
    dragRef.current = drag
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  const beginEditDrag = (e: ReactPointerEvent, edit: LayoutDrag, pressed?: SingleSelection, toggle = false) =>
    beginDrag(e, { kind: 'edit', edit, start: toWorld(e), moved: false, pressed, toggle })

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
      beginEditDrag(e, group, item, toggling)
    } else {
      if (!toggling) onSelect(item)
      beginEditDrag(e, singleDrag(withLeads), item, toggling)
    }
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
    beginEditDrag(e, { kind: 'resize', net: island.net, rectIndex, sides, rect, neighbours })
  }

  const onCutPointerDown = (e: ReactPointerEvent, cut: Cut) => {
    if (e.button !== 0) return
    e.stopPropagation()
    beginEditDrag(e, { kind: 'cut', cut, islands: layout.islands })
  }

  const onEdgePointerDown = (e: ReactPointerEvent, net: string, edge: IslandEdge) => {
    if (e.button !== 0) return
    e.stopPropagation()
    beginEditDrag(e, { kind: 'edge', net, edge, islands: layout.islands })
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
    beginEditDrag(e, { kind: 'lead', ref: placement.ref, pin, origin })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'pan') {
      setView(pannedView(drag, e))
      return
    }
    if (drag.kind === 'marquee') {
      setMarquee(rectBetween(drag.start, toWorld(e)))
      return
    }
    const p = toWorld(e)
    const delta = { x: p.x - drag.start.x, y: p.y - drag.start.y }
    if (!drag.moved) {
      // Island edges snap to the grid, not by the delta, so the slightest jitter could move an
      // off-grid island: a press must move a few pixels before it counts as a drag.
      if (Math.hypot(delta.x, delta.y) * view.scale <= CLICK_TOLERANCE_PX) return
      drag.moved = true
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
    dragRef.current = null
    svgRef.current!.releasePointerCapture(e.pointerId)
    if (drag?.kind === 'marquee') finishMarquee(drag, e)
    else if (drag?.kind === 'edit' && drag.pressed && !drag.moved) {
      if (drag.toggle) onSelect(toggleSelected(selection, drag.pressed))
      // A click without dragging on an item of a multi-selection selects just that item.
      else if (drag.edit.kind === 'group') onSelect(drag.pressed)
    }
  }

  // Sizes that should stay constant on screen, expressed in mm.
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale, gridPitches(FINE_GRID_MM, gridLinesPerMajor))
  const selectedIsland = selection?.kind === 'island' ? islandsByNet.get(selection.net) : undefined
  const selectedRectIndex = selection?.kind === 'island' ? selection.rectIndex : -1
  const handleRect = rectHandles ? selectedIsland?.rects[selectedRectIndex] : undefined
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
          const style = islandStyle(island.plane === true, highlightedNets.has(island.net), problemNets.has(island.net))
          return (
            <g key={island.net} className="island">
              {/* The copper left after cutting; the rectangles themselves only catch the pointer. */}
              <path
                d={outlinePath(island.rects, isolation / 2)}
                fill={style.fill}
                fillRule="evenodd"
                stroke={style.stroke}
                strokeWidth={style.strokeWidthPx * px}
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

        {parts.map((part) => {
          const { ref } = part.component
          return (
            <LayoutPart
              key={ref}
              part={part}
              selected={highlightedRefs.has(ref)}
              opacity={partOpacity(ref) * layers.parts.opacity}
              px={px}
              onPointerDown={(e) => onPartPointerDown(e, ref)}
              onPointerEnter={() => setHoveredRef(ref)}
              onPointerLeave={() => setHoveredRef((hovered) => (hovered === ref ? null : hovered))}
              onLeadPointerDown={(e, pin, end) => onLeadPointerDown(e, part.placement, pin, end)}
            />
          )
        })}

        {selectedIsland &&
          selectedEdges.map((edge, k) => {
            const net = selectedIsland.net
            const hoverKey = `${net}:${k}`
            return (
              <IslandEdgeHandle
                key={k}
                edge={edge}
                px={px}
                hovered={hoveredEdge === hoverKey}
                onPointerEnter={() => setHoveredEdge(hoverKey)}
                onPointerLeave={() => setHoveredEdge((key) => (key === hoverKey ? null : key))}
                onEdgePointerDown={(e) => onEdgePointerDown(e, net, edge)}
                onGrowPointerDown={(e) => onGrowPointerDown(e, net, edge)}
              />
            )
          })}

        {/* Handles only on the clicked rectangle: optimized islands can consist of hundreds. */}
        {selectedIsland && handleRect && (
          <RectHandles
            rect={handleRect}
            outlined={selectedIsland.rects.length > 1}
            px={px}
            onHandlePointerDown={(e, handle) => onHandlePointerDown(e, selectedIsland, selectedRectIndex, handle)}
          />
        )}

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
