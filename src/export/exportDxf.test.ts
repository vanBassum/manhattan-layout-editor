import { describe, expect, it } from 'vitest'
import { exportDxf } from './exportDxf'
import type { Island } from '../model/types'

const BOARD: Island[] = [
  { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] },
  { net: 'B', rects: [{ x: 10, y: 0, w: 10, h: 5 }] },
]

const polyline = (...points: [number, number][]) => [
  '0', 'POLYLINE', '8', 'ISOLATION', '66', '1', '10', '0', '20', '0', '30', '0', '70', '1',
  ...points.flatMap(([x, y]) => ['0', 'VERTEX', '8', 'ISOLATION', '10', String(x), '20', String(y), '30', '0']),
  '0', 'SEQEND', '8', 'ISOLATION',
]

describe('exportDxf', () => {
  it('gives the board grown by half the isolation, and each island shrunk by it, with y pointing up', () => {
    const codes = [
      '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '9', '$MEASUREMENT', '70', '1', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      ...polyline([-0.2, 0.2], [20.2, 0.2], [20.2, -5.2], [-0.2, -5.2]),
      ...polyline([0.2, -0.2], [9.8, -0.2], [9.8, -4.8], [0.2, -4.8]),
      ...polyline([10.2, -0.2], [19.8, -0.2], [19.8, -4.8], [10.2, -4.8]),
      '0', 'ENDSEC', '0', 'EOF',
    ]

    expect(exportDxf(BOARD, 0.4)).toBe(codes.join('\r\n') + '\r\n')
  })
})
