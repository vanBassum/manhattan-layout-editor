import { describe, expect, it } from 'vitest'
import { buildNetlist } from './definitions'
import { findPinIssues, findProblemNets } from './layout'
import type { Island, Layout, NetComponent } from './types'

describe('findProblemNets', () => {
  it('names nets whose islands overlap another net, and nets split into separate pieces', () => {
    const islands: Island[] = [
      { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 10 }] },
      { net: 'B', rects: [{ x: 5, y: 5, w: 10, h: 10 }] },
      { net: 'C', rects: [{ x: 50, y: 0, w: 5, h: 5 }, { x: 70, y: 0, w: 5, h: 5 }] },
      { net: 'D', rects: [{ x: 50, y: 20, w: 5, h: 5 }, { x: 55, y: 20, w: 5, h: 5 }] },
    ]

    expect(findProblemNets(islands)).toEqual(new Set(['A', 'B', 'C']))
  })
})

describe('findPinIssues', () => {
  const part = (ref: string, nets: string[]): NetComponent => ({
    ref,
    value: '1k',
    footprint: 'R_AXIAL-0.4',
    pins: nets.map((net, k) => ({ number: String(k + 1), net })),
  })
  const components = [part('R1', ['A', 'B']), part('R2', ['', ''])]
  const placements = [
    { ref: 'R1', x: 0, y: 0, rotation: 0 },
    { ref: 'R2', x: 30, y: 0, rotation: 0 },
    // A placement whose part is no longer in the netlist is left out.
    { ref: 'R9', x: 60, y: 0, rotation: 0 },
  ]
  const built = buildNetlist({ components, nets: ['A', 'B'] }, placements, undefined)

  it('counts leads that reach no copper of their net as open; unused pins are no issue', () => {
    const layout: Layout = { islands: [], placements }

    expect(findPinIssues(built, layout, 0.4)).toEqual({ open: 2, short: 0, refsWithIssues: new Set(['R1']) })
  })

  it("counts leads on another net's copper as shorted", () => {
    const layout: Layout = { islands: [{ net: 'C', rects: [{ x: -20, y: -20, w: 40, h: 40 }] }], placements }

    expect(findPinIssues(built, layout, 0.4)).toEqual({ open: 0, short: 2, refsWithIssues: new Set(['R1']) })
  })
})
