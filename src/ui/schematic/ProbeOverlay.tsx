import { isGroundNet, isRealNet } from '../../model/netlist'
import type { PlacedPart } from '../../model/schematic'
import type { Point } from '../../model/types'
import { probePart } from '../../simulation/probe'
import type { OperatingPoint } from '../../simulation/spiceNetlist'
import { formatQuantity } from '../quantity'

// The operating point drawn onto the schematic: a voltage tag on every net and a current tag on
// every transistor, and the readings of the part clicked.

/** Where a net's tag points: the first pin end on it, in the order parts are drawn. */
function netAnchors(parts: PlacedPart[]): Map<string, Point> {
  const anchors = new Map<string, Point>()
  for (const { component, pins } of parts) {
    component.pins.forEach(({ net }, k) => {
      if (isRealNet(net) && !isGroundNet(net) && !anchors.has(net)) anchors.set(net, pins[k])
    })
  }
  return anchors
}

interface TagProps {
  at: Point
  text: string
  kind: 'voltage' | 'current'
  /** World units per screen pixel, so tags keep their size at any zoom. */
  px: number
}

/** A rounded tag up and to the right of `at`, with a short leader to it. */
function Tag({ at, text, kind, px }: TagProps) {
  const width = (text.length * 6.6 + 12) * px
  const height = 18 * px
  const x = at.x + 8 * px
  const y = at.y - 8 * px - height
  return (
    <g className={`probe-tag ${kind}`} pointerEvents="none">
      <line x1={at.x} y1={at.y} x2={x} y2={y + height} strokeWidth={1.5 * px} />
      <rect x={x} y={y} width={width} height={height} rx={4 * px} strokeWidth={1.5 * px} />
      <text x={x + width / 2} y={y + height / 2} fontSize={11 * px} textAnchor="middle" dominantBaseline="central">
        {text}
      </text>
    </g>
  )
}

/** Every net's voltage and every transistor's collector current, as tags in the schematic's world units. */
export function ProbeTags({ parts, point, px }: { parts: PlacedPart[]; point: OperatingPoint; px: number }) {
  const placements = new Map(parts.map((p) => [p.placement.ref, p.placement]))
  return (
    <g className="probe-tags">
      {[...netAnchors(parts)].map(([net, at]) => {
        const volts = point.volts.get(net)
        return volts === undefined ? null : <Tag key={net} at={at} text={formatQuantity(volts, 'V')} kind="voltage" px={px} />
      })}
      {point.transistors.map((t) => {
        const placement = placements.get(t.ref)
        if (!placement) return null
        // Below the symbol's middle, clear of its ref and value text on the right.
        return <Tag key={t.ref} at={{ x: placement.x, y: placement.y + 3 }} text={formatQuantity(Math.abs(t.ic), 'A')} kind="current" px={px} />
      })}
    </g>
  )
}

interface ProbePopupProps {
  part: PlacedPart
  point: OperatingPoint
  /** Where the part is on screen, relative to the schematic view. */
  at: Point
  /** The schematic view's width in pixels: near its right edge the popup opens to the part's left. */
  viewWidth: number
  onClose: () => void
}

/** Room the popup needs beside the part, in pixels; a little more than its usual width. */
const POPUP_ROOM = 240

/** The readings of one part, beside it. */
export function ProbePopup({ part, point, at, viewWidth, onClose }: ProbePopupProps) {
  const rows = probePart(part.component, point)
  const side = at.x + 24 + POPUP_ROOM <= viewWidth ? { left: at.x + 24 } : { right: Math.max(8, viewWidth - at.x + 24) }
  return (
    <div className="probe-popup" style={{ ...side, top: Math.max(8, at.y - 60) }} role="dialog" aria-label={`Readings of ${part.component.ref}`}>
      <div className="probe-popup-title">
        <span>
          {part.component.ref} – {part.component.value}
        </span>
        <button className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {rows ? (
        <dl className="probe-readings">
          {rows.map((row) => (
            <div key={row.name}>
              <dt>{row.name}</dt>
              <dd>{formatQuantity(row.value, row.unit)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">No readings for this part.</p>
      )}
    </div>
  )
}
