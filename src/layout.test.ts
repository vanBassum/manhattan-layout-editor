import { describe, expect, it } from 'vitest'
import { buildNetlist } from './definitions'
import { findPinIssues, findProblemNets, gridDelta, moveGroup, movePart, moveRects, replaceIslandRects, replaceRect } from './layout'
import type { Island, Layout, NetComponent, Placement } from './types'

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

describe('moving islands', () => {
  const layout: Layout = {
    islands: [
      { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }, { x: 0, y: 5, w: 5, h: 5 }] },
      { net: 'GND', plane: true, rects: [{ x: 20, y: 0, w: 10, h: 10 }] },
    ],
    placements: [],
  }

  it('replaces the rectangles of one island and keeps the rest of it', () => {
    const rects = [{ x: 1, y: 1, w: 2, h: 2 }]

    expect(replaceIslandRects(layout, 'GND', rects).islands).toEqual([layout.islands[0], { net: 'GND', plane: true, rects }])
  })

  it('replaces one rectangle of an island', () => {
    const rect = { x: 0, y: 5, w: 6, h: 5 }

    expect(replaceRect(layout, 'A', 1, rect).islands[0].rects).toEqual([layout.islands[0].rects[0], rect])
  })

  it('moves rectangles without floating point fuzz', () => {
    expect(moveRects([{ x: 0.1, y: 0, w: 1, h: 1 }], 0.2, 1)).toEqual([{ x: 0.3, y: 1, w: 1, h: 1 }])
  })

  it('snaps the first rectangle onto the grid; the delta that does that moves the rest along', () => {
    const rects = [{ x: 0.4, y: 1, w: 1, h: 1 }, { x: 3, y: 3, w: 1, h: 1 }]

    expect(gridDelta(rects, 1.3, -0.2, 1)).toEqual({ x: 1.6, y: 0 })
  })
})

describe('moving parts', () => {
  const placement: Placement = { ref: 'R1', x: 10, y: 10, rotation: 0, leads: { '1': { x: -5, y: 0 } } }

  it('moves the part with its leads from where the move started', () => {
    const current = { ...placement, x: 99, rotation: 90 }

    expect(movePart(current, { placement }, 2, 3)).toEqual({ ...current, x: 12, y: 13 })
  })

  it('keeps the lead ends where they were when only the body moves', () => {
    const moved = movePart(placement, { placement, worldLeadEnds: { '1': { x: 5, y: 10 } } }, 2, 0)

    expect(moved).toEqual({ ...placement, x: 12, leads: { '1': { x: -7, y: 0 } } })
  })

  it('moves a group of parts and islands by the same delta, leaving the others', () => {
    const other: Placement = { ref: 'R2', x: 0, y: 0, rotation: 0 }
    const a = { net: 'A', rects: [{ x: 0, y: 0, w: 5, h: 5 }] }
    const b = { net: 'B', rects: [{ x: 5, y: 0, w: 5, h: 5 }] }
    const layout: Layout = { islands: [a, b], placements: [placement, other] }

    expect(moveGroup(layout, [{ placement }], [a], 1, 2)).toEqual({
      islands: [{ net: 'A', rects: [{ x: 1, y: 2, w: 5, h: 5 }] }, b],
      placements: [{ ...placement, x: 11, y: 12 }, other],
    })
  })
})
