import type { Geometry } from '../../types'

export const COPPER_COLOR = '#d9945a'
export const LEAD_COLOR = '#777777'

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
