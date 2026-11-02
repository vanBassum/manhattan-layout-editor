import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, inflate, rotatePoint, snapToGrid } from './geometry'
import { CELL_HEIGHT, CELL_WIDTH, pinEnds, pointKey, SCHEMATIC_GRID, withPlacementChanges, type FullSchematic, type SchematicNets } from './schematic'
import { symbolFor, type SymbolPin } from './schematicSymbols'
import { selectedRefs } from './selection'
import type { NetComponent, NetLabel, Netlist, Point, SchematicPlacement, Selection, Wire } from './types'
import { gridPitch, Rulers, useViewport, ViewportGrid, type View } from './viewport'

/** Select: click and drag parts, wires and labels. Wire: drag from point to point. Label: click to name a point. */
export type SchematicTool = 'select' | 'wire' | 'label'

/** Schematic grid pitches in mm: 0.1 inch and up; every fifth line is solid. Pins sit on the finest one. */
const GRID_PITCHES_MM = [SCHEMATIC_GRID, 12.7, 63.5, 317.5]

/** A press that moves less than this (screen pixels) is a click, not a drag. */
const CLICK_TOLERANCE_PX = 3

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  /** Moves are applied to `base`, the schematic at the start: only what was on the pins then goes along. */
  | { kind: 'part'; ref: string; start: Point; origin: SchematicPlacement; base: FullSchematic; moved: boolean }
  | { kind: 'wire'; start: Point }

type Item = { kind: 'wire'; index: number } | { kind: 'label'; index: number }

const snapPoint = (p: Point): Point => ({ x: snapToGrid(p.x, SCHEMATIC_GRID), y: snapToGrid(p.y, SCHEMATIC_GRID) })

/** Horizontal or vertical, whichever way the pointer went furthest. */
function straightWire(start: Point, end: Point): Wire {
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
  return horizontal ? { x1: start.x, y1: start.y, x2: end.x, y2: start.y } : { x1: start.x, y1: start.y, x2: start.x, y2: end.y }
}

const isGround = (name: string) => /^(GND|AGND|DGND|PGND|VSS|0)$/i.test(name)

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

interface PartProps {
  component: NetComponent
  placement: SchematicPlacement
  pins: SymbolPin[]
  selected: boolean
  onPointerDown: (e: ReactPointerEvent) => void
}

/** The body rotates with the part; reference and value stay upright. Unconnected pins get an open circle. */
function SchematicPart({ component, placement, pins, selected, onPointerDown }: PartProps) {
  const symbol = symbolFor(component)
  const { x, y, rotation } = placement
  const pinBounds = boundsOf(pins.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))
  const hitArea = pinBounds && inflate(pinBounds, 2)
  const labelOffset = rotatePoint(symbol.label, rotation)
  const label = { x: x + labelOffset.x, y: y + labelOffset.y }
  return (
    <g className={selected ? 'sch-part selected' : 'sch-part'} onPointerDown={onPointerDown}>
      <title>{`${component.ref} ${component.value}`}</title>
      {hitArea && <rect className="sch-hit" x={hitArea.x} y={hitArea.y} width={hitArea.w} height={hitArea.h} />}
      <g transform={`translate(${x} ${y}) rotate(${rotation})`}>{symbol.body}</g>
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
  const [wirePreview, setWirePreview] = useState<Wire | null>(null)
  const { view, setView, size, fitTo } = useViewport(svgRef)
  const highlightedRefs = new Set(selectedRefs(selection))

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

  const removeItem = () => {
    if (!item) return
    onBeginEdit()
    if (item.kind === 'wire') onChange({ ...schematic, wires: schematic.wires.filter((_, k) => k !== item.index) })
    else onChange({ ...schematic, labels: schematic.labels.filter((_, k) => k !== item.index) })
    setItem(null)
  }

  const removeItemRef = useRef(removeItem)
  removeItemRef.current = removeItem
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'Delete' || e.key === 'Backspace') removeItemRef.current()
      if (e.key === 'Escape') setItem(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale }
  }

  const beginDrag = (e: ReactPointerEvent, drag: Drag) => {
    dragRef.current = drag
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  const askLabelName = (current = '') => window.prompt('Net name (labels with the same name are connected)', current)?.trim()

  const onBackgroundPointerDown = (e: ReactPointerEvent) => {
    if (e.button === 0 && tool === 'wire') {
      beginDrag(e, { kind: 'wire', start: snapPoint(toWorld(e)) })
      return
    }
    if (e.button === 0 && tool === 'label') {
      const at = snapPoint(toWorld(e))
      const name = askLabelName()
      if (!name) return
      onBeginEdit()
      onChange({ ...schematic, labels: [...schematic.labels, { ...at, name }] })
      return
    }
    if (e.button === 0) {
      onSelect(null)
      setItem(null)
    }
    beginDrag(e, { kind: 'pan', startX: e.clientX, startY: e.clientY, view })
  }

  /** In the wire and label tools everything acts as background, so wires can start on a pin. */
  const selectToolOnly = (e: ReactPointerEvent) => e.button === 0 && tool === 'select'

  const onPartPointerDown = (e: ReactPointerEvent, placement: SchematicPlacement) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    onSelect({ kind: 'part', ref: placement.ref })
    beginDrag(e, { kind: 'part', ref: placement.ref, start: toWorld(e), origin: placement, base: schematic, moved: false })
  }

  const onItemPointerDown = (e: ReactPointerEvent, picked: Item) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    onSelect(null)
    setItem(picked)
  }

  const renameLabel = (index: number) => {
    const name = askLabelName(schematic.labels[index].name)
    if (!name) return
    onBeginEdit()
    onChange({ ...schematic, labels: schematic.labels.map((l, k) => (k === index ? { ...l, name } : l)) })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'pan') {
      setView({ ...drag.view, ox: drag.view.ox + e.clientX - drag.startX, oy: drag.view.oy + e.clientY - drag.startY })
      return
    }
    const p = toWorld(e)
    if (drag.kind === 'wire') {
      setWirePreview(straightWire(drag.start, snapPoint(p)))
      return
    }
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    if (!drag.moved) {
      if (Math.hypot(dx, dy) * view.scale <= CLICK_TOLERANCE_PX) return
      drag.moved = true
      onBeginEdit()
    }
    const moved = { ...drag.origin, ...snapPoint({ x: drag.origin.x + dx, y: drag.origin.y + dy }) }
    onChange(withPlacementChanges(drag.base, netlist, [moved]))
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    svgRef.current!.releasePointerCapture(e.pointerId)
    if (drag?.kind === 'wire') {
      const wire = wirePreview
      setWirePreview(null)
      if (wire && (wire.x1 !== wire.x2 || wire.y1 !== wire.y2)) {
        onBeginEdit()
        onChange({ ...schematic, wires: [...schematic.wires, wire] })
      }
    }
  }

  const componentsByRef = new Map(netlist.components.map((c) => [c.ref, c]))
  const parts = schematic.placements.flatMap((placement) => {
    const component = componentsByRef.get(placement.ref)
    return component ? [{ component, placement, pins: pinEnds(component, placement) }] : []
  })
  const pinDirections = new Map(parts.flatMap(({ pins }) => pins.map((pin) => [pointKey(pin), { x: pin.dx, y: pin.dy }] as const)))
  const conflictPoints = new Set(nets.conflicts.flatMap((c) => c.points.map(pointKey)))
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale, GRID_PITCHES_MM)
  return (
    <div className="schematic-view">
      <svg
        ref={svgRef}
        className={`schematic tool-${tool}`}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${view.ox} ${view.oy}) scale(${view.scale})`}>
          <ViewportGrid view={view} size={size} pitch={pitch} />
          {schematic.wires.map((w, k) => {
            const selected = item?.kind === 'wire' && item.index === k
            return (
              <g key={k} className={selected ? 'sch-wire-item selected' : 'sch-wire-item'} onPointerDown={(e) => onItemPointerDown(e, { kind: 'wire', index: k })}>
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
                onPointerDown={(e) => onItemPointerDown(e, { kind: 'label', index: k })}
                onDoubleClick={() => renameLabel(k)}
              />
            )
          })}
          {wirePreview && <line className="sch-wire preview" x1={wirePreview.x1} y1={wirePreview.y1} x2={wirePreview.x2} y2={wirePreview.y2} />}
        </g>
        <Rulers view={view} size={size} pitch={pitch} />
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
