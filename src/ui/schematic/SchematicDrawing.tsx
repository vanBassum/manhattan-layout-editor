import type { PointerEvent as ReactPointerEvent } from 'react'
import { rotatePoint } from '../../model/geometry'
import { labelSymbol } from '../../model/schematic'
import type { BuiltComponent, NetLabel, PinEnd, Point, SchematicPlacement, SymbolGraphic } from '../../model/types'

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
export function LabelMark({ label, direction, className, onPointerDown, onDoubleClick }: LabelProps) {
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
export const textOffsetOf = (component: BuiltComponent, placement: SchematicPlacement): Point =>
  placement.textOffset ?? rotatePoint(component.symbol.label, placement.rotation)

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
export function SchematicPart({ component, placement, pins, selected, onPointerDown, onTextPointerDown }: PartProps) {
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
