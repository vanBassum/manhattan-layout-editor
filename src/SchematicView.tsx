import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, inflate, rotatePoint, snapToGrid } from './geometry'
import { isRealNet } from './netlist'
import { CELL_HEIGHT, CELL_WIDTH, SCHEMATIC_GRID } from './schematic'
import { symbolFor, type SymbolPin } from './schematicSymbols'
import { selectedRefs } from './selection'
import type { NetComponent, Netlist, Point, SchematicPlacement, Selection } from './types'
import { gridPitch, Rulers, useViewport, ViewportGrid, type View } from './viewport'

// Symbols can be dragged and rotated; net names at the pins stand in for wires until those are routed.

/** Schematic grid pitches in mm: 0.1 inch and up; every fifth line is solid. Pins sit on the finest one. */
const GRID_PITCHES_MM = [SCHEMATIC_GRID, 12.7, 63.5, 317.5]

/** A press that moves less than this (screen pixels) is a click, not a drag. */
const CLICK_TOLERANCE_PX = 3

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'part'; ref: string; start: Point; origin: Point; moved: boolean }

const isGround = (net: string) => /^(GND|AGND|DGND|PGND|VSS|0)$/i.test(net)

/** Ground as the thick bar from the reference drawings; any other net as its name. */
function NetMark({ pin, net }: { pin: SymbolPin; net: string }) {
  if (isGround(net)) {
    const stubEnd = pin.y + 2.54
    return (
      <>
        <polyline className="sch-line" points={`${pin.x},${pin.y} ${pin.x},${stubEnd}`} />
        <rect className="sch-fill" x={pin.x - 1.52} y={stubEnd} width={3.04} height={0.6} />
      </>
    )
  }
  const horizontal = pin.dx !== 0
  return (
    <text
      className="sch-net"
      x={pin.x + pin.dx * 0.6}
      y={horizontal ? pin.y + 0.45 : pin.y + pin.dy * 1.2 + (pin.dy > 0 ? 0.9 : 0)}
      textAnchor={horizontal ? (pin.dx > 0 ? 'start' : 'end') : 'middle'}
    >
      {net}
    </text>
  )
}

interface PartProps {
  component: NetComponent
  placement: SchematicPlacement
  selected: boolean
  onPointerDown: (e: ReactPointerEvent) => void
}

/** The body rotates with the part; reference, value and net names stay upright. */
function SchematicPart({ component, placement, selected, onPointerDown }: PartProps) {
  const symbol = symbolFor(component)
  const { x, y, rotation } = placement
  const place = (p: Point) => {
    const r = rotatePoint(p, rotation)
    return { x: x + r.x, y: y + r.y }
  }
  const pins = symbol.pins.map((pin) => {
    const direction = rotatePoint({ x: pin.dx, y: pin.dy }, rotation)
    return { ...place(pin), dx: Math.round(direction.x), dy: Math.round(direction.y) }
  })
  const label = place(symbol.label)
  const pinBounds = boundsOf(pins.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))
  const hitArea = pinBounds && inflate(pinBounds, 2)
  return (
    <g className={selected ? 'sch-part selected' : 'sch-part'} onPointerDown={onPointerDown}>
      <title>{`${component.ref} ${component.value}`}</title>
      {hitArea && <rect className="sch-hit" x={hitArea.x} y={hitArea.y} width={hitArea.w} height={hitArea.h} />}
      <g transform={`translate(${x} ${y}) rotate(${rotation})`}>{symbol.body}</g>
      <text className="sch-ref" x={label.x} y={label.y}>{component.ref}</text>
      <text className="sch-value" x={label.x} y={label.y + 1.5}>{component.value}</text>
      {pins.map((pin, k) => {
        const net = component.pins[k]?.net ?? ''
        return isRealNet(net) && <NetMark key={k} pin={pin} net={net} />
      })}
    </g>
  )
}

interface Props {
  netlist: Netlist
  /** One per component, in netlist order. */
  placements: SchematicPlacement[]
  onMovePart: (ref: string, x: number, y: number) => void
  /** Called once per drag, just before its first change, so the drag can be undone as a whole. */
  onBeginEdit: () => void
  selection: Selection
  onSelect: (selection: Selection) => void
  fitRequest: number
}

export function SchematicView({ netlist, placements, onMovePart, onBeginEdit, selection, onSelect, fitRequest }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const { view, setView, size, fitTo } = useViewport(svgRef)
  const highlightedRefs = new Set(selectedRefs(selection))

  useEffect(() => {
    const cells = placements.map((p) => ({ x: p.x - CELL_WIDTH / 2, y: p.y - CELL_HEIGHT / 2, w: CELL_WIDTH, h: CELL_HEIGHT }))
    const bounds = boundsOf(cells)
    if (bounds) fitTo(inflate(bounds, 5))
    // Only refit when explicitly requested, not on every move.
  }, [fitRequest])

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale }
  }

  const beginDrag = (e: ReactPointerEvent, drag: Drag) => {
    dragRef.current = drag
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  const onBackgroundPointerDown = (e: ReactPointerEvent) => {
    if (e.button === 0) onSelect(null)
    beginDrag(e, { kind: 'pan', startX: e.clientX, startY: e.clientY, view })
  }

  const onPartPointerDown = (e: ReactPointerEvent, placement: SchematicPlacement) => {
    // Other buttons fall through to the background, which pans.
    if (e.button !== 0) return
    e.stopPropagation()
    onSelect({ kind: 'part', ref: placement.ref })
    beginDrag(e, { kind: 'part', ref: placement.ref, start: toWorld(e), origin: { x: placement.x, y: placement.y }, moved: false })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'pan') {
      setView({ ...drag.view, ox: drag.view.ox + e.clientX - drag.startX, oy: drag.view.oy + e.clientY - drag.startY })
      return
    }
    const p = toWorld(e)
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    if (!drag.moved) {
      if (Math.hypot(dx, dy) * view.scale <= CLICK_TOLERANCE_PX) return
      drag.moved = true
      onBeginEdit()
    }
    onMovePart(drag.ref, snapToGrid(drag.origin.x + dx, SCHEMATIC_GRID), snapToGrid(drag.origin.y + dy, SCHEMATIC_GRID))
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    dragRef.current = null
    svgRef.current!.releasePointerCapture(e.pointerId)
  }

  const componentsByRef = new Map(netlist.components.map((c) => [c.ref, c]))
  const pitch = gridPitch(view.scale, GRID_PITCHES_MM)
  return (
    <div className="schematic-view">
      <svg
        ref={svgRef}
        className="schematic"
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${view.ox} ${view.oy}) scale(${view.scale})`}>
          <ViewportGrid view={view} size={size} pitch={pitch} />
          {placements.map((placement) => {
            const component = componentsByRef.get(placement.ref)
            return (
              component && (
                <SchematicPart
                  key={placement.ref}
                  component={component}
                  placement={placement}
                  selected={highlightedRefs.has(placement.ref)}
                  onPointerDown={(e) => onPartPointerDown(e, placement)}
                />
              )
            )
          })}
        </g>
        <Rulers view={view} size={size} pitch={pitch} />
      </svg>
      {placements.length === 0 && <p className="schematic-empty">Import a netlist to see its schematic.</p>}
    </div>
  )
}
