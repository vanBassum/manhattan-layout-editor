import { insetOutline } from './geometry'
import type { Island, Point } from './types'

const LAYER = 'ISOLATION'

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)

/**
 * The area to burn away, for laser software that fills closed contours with a hatch (EzCad):
 * the board outline, grown by isolation/2, plus the copper of every island (its outline shrunk by
 * isolation/2) as holes. Hatched with even-odd filling, only the isolation channels and the band
 * around the board are burned. Islands lying on a ground plane overlap it and break even-odd
 * filling, so this suits knife-style layouts. R12 POLYLINE entities in millimeters, which every
 * DXF reader understands; DXF's y axis points up, so y is negated.
 */
export function exportDxf(islands: Island[], isolation: number): string {
  const half = isolation / 2
  const board = insetOutline(islands.flatMap((i) => i.rects), -half)
  const copper = islands.flatMap((i) => insetOutline(i.rects, half))

  const codes: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 9, '$MEASUREMENT', 70, 1, 0, 'ENDSEC']
  codes.push(0, 'SECTION', 2, 'ENTITIES')
  for (const loop of [...board, ...copper]) codes.push(...polyline(loop))
  codes.push(0, 'ENDSEC', 0, 'EOF')
  return codes.join('\r\n') + '\r\n'
}

function polyline(loop: Point[]): (string | number)[] {
  const codes: (string | number)[] = [0, 'POLYLINE', 8, LAYER, 66, 1, 10, 0, 20, 0, 30, 0, 70, 1]
  for (const p of loop) codes.push(0, 'VERTEX', 8, LAYER, 10, fmt(p.x), 20, fmt(-p.y), 30, 0)
  codes.push(0, 'SEQEND', 8, LAYER)
  return codes
}
