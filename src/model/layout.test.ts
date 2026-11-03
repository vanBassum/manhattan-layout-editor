import { describe, expect, it } from 'vitest'
import { buildNetlist } from './definitions'
import {
  analyzeLeads,
  chooseFootprints,
  chooseResistors,
  createLayout,
  findPinIssues,
  findProblemNets,
  findSplitNets,
  followNetlist,
  gridDelta,
  moveGroup,
  movePart,
  moveRects,
  replaceIslandRects,
} from './layout'
import type { Island, Layout, NetComponent, Netlist, Placement } from './types'

/** A resistor whose unbent lead ends lie at x = -5.08 and x = 5.08 when placed at 0,0. */
const resistor = (ref: string, nets: string[]): NetComponent => ({
  ref,
  value: '1k',
  footprint: 'R_AXIAL-0.4',
  pins: nets.map((net, k) => ({ number: String(k + 1), net })),
})

const LEFT_PAD: Island['rects'] = [{ x: -10, y: -5, w: 8, h: 10 }]
const RIGHT_PAD: Island['rects'] = [{ x: 2, y: -5, w: 8, h: 10 }]

describe('analyzeLeads', () => {
  const placement: Placement = { ref: 'R1', x: 0, y: 0, rotation: 0 }
  const statuses = (nets: string[], islands: Island[]) => {
    const [component] = buildNetlist({ components: [resistor('R1', nets)], nets: [] }, undefined).components
    return analyzeLeads(component, placement, islands, 0.4).map((lead) => lead.status)
  }

  it("calls a lead ok on its own net's copper, short on another's and open on none", () => {
    expect(statuses(['A', 'B'], [{ net: 'A', rects: LEFT_PAD }, { net: 'C', rects: RIGHT_PAD }])).toEqual(['ok', 'short'])
    expect(statuses(['A', 'B'], [{ net: 'A', rects: LEFT_PAD }])).toEqual(['ok', 'open'])
  })

  it('calls a pin on no net unused', () => {
    expect(statuses(['A', ''], [{ net: 'A', rects: LEFT_PAD }])).toEqual(['ok', 'unused'])
  })

  it('lets a pad glued onto a ground plane insulate its leads from the plane', () => {
    const plane: Island = { net: 'GND', plane: true, rects: [{ x: -20, y: -20, w: 40, h: 40 }] }

    expect(statuses(['A', 'B'], [plane, { net: 'A', rects: LEFT_PAD }, { net: 'B', rects: RIGHT_PAD }])).toEqual(['ok', 'ok'])
    expect(statuses(['A', 'GND'], [plane, { net: 'A', rects: LEFT_PAD }])).toEqual(['ok', 'ok'])
    expect(statuses(['A', 'B'], [plane, { net: 'A', rects: LEFT_PAD }])).toEqual(['ok', 'short'])
  })
})

describe('findSplitNets', () => {
  it('names islands whose pieces only touch at a corner or not at all; overlapping or edge-sharing pieces are one', () => {
    const islands: Island[] = [
      { net: 'corner', rects: [{ x: 0, y: 0, w: 5, h: 5 }, { x: 5, y: 5, w: 5, h: 5 }] },
      { net: 'apart', rects: [{ x: 0, y: 20, w: 5, h: 5 }, { x: 6, y: 20, w: 5, h: 5 }] },
      { net: 'overlap', rects: [{ x: 0, y: 40, w: 5, h: 5 }, { x: 3, y: 42, w: 5, h: 5 }] },
      { net: 'chain', rects: [{ x: 0, y: 60, w: 5, h: 5 }, { x: 10, y: 60, w: 5, h: 5 }, { x: 5, y: 60, w: 5, h: 5 }] },
    ]

    expect(findSplitNets(islands)).toEqual(new Set(['corner', 'apart']))
  })
})

describe('followNetlist', () => {
  const placements: Placement[] = [{ ref: 'R1', x: 0, y: 0, rotation: 0 }]
  const layout: Layout = {
    islands: [
      { net: 'A', rects: LEFT_PAD },
      { net: 'B', rects: RIGHT_PAD },
    ],
    placements,
  }
  const before: Netlist = { components: [resistor('R1', ['A', 'B'])], nets: ['A', 'B'] }

  it('keeps the layout when no connection changed', () => {
    const after = buildNetlist(before, undefined)

    expect(followNetlist(layout, before, after)).toBe(layout)
  })

  it('hands the copper of a renamed net to its new name', () => {
    const after = buildNetlist({ components: [resistor('R1', ['X', 'B'])], nets: ['B', 'X'] }, undefined)

    expect(followNetlist(layout, before, after)).toEqual({ islands: [{ net: 'X', rects: LEFT_PAD }, { net: 'B', rects: RIGHT_PAD }], placements })
  })
})

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
  const components = [resistor('R1', ['A', 'B']), resistor('R2', ['', ''])]
  const placements = [
    { ref: 'R1', x: 0, y: 0, rotation: 0 },
    { ref: 'R2', x: 30, y: 0, rotation: 0 },
    // A placement whose part is no longer in the netlist is left out.
    { ref: 'R9', x: 60, y: 0, rotation: 0 },
  ]
  const built = buildNetlist({ components, nets: ['A', 'B'] }, undefined)

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

describe('choosing footprints', () => {
  const bent = { '1': { x: -3, y: 2 } }
  const project = {
    netlist: { components: [resistor('R1', ['A', 'B']), resistor('R2', ['A', 'B']), { ...resistor('RV1', ['A', 'B']), footprint: 'RES-ADJ' }], nets: ['A', 'B'] },
    layout: {
      islands: [],
      placements: ['R1', 'R2', 'RV1'].map((ref) => ({ ref, x: 0, y: 0, rotation: 0, leads: bent })),
    },
  }
  const choices = (p: { netlist: Netlist }) => p.netlist.components.map((c) => c.chosenFootprint)

  it('stores the choice on the part and resets its bent leads', () => {
    const chosen = chooseFootprints(project, new Set(['R1']), 'R1206')

    expect(choices(chosen)).toEqual(['R1206', undefined, undefined])
    expect(chosen.netlist.components[0].footprint).toBe('R_AXIAL-0.4')
    expect(chosen.layout.placements.map((p) => p.leads)).toEqual([undefined, bent, bent])
  })

  it("stores no choice for the part's own netlist footprint, or for going back to it", () => {
    const chosen = chooseFootprints(project, new Set(['R1', 'R2']), 'R1206')

    expect(choices(chooseFootprints(chosen, new Set(['R1']), undefined))).toEqual([undefined, 'R1206', undefined])
    expect(choices(chooseFootprints(chosen, new Set(['R2']), 'R_AXIAL-0.4'))).toEqual(['R1206', undefined, undefined])
  })

  it('builds only plain resistors as 1206 chips, and through-hole again', () => {
    const chips = chooseResistors(project, '1206')

    expect(choices(chips)).toEqual(['R1206', 'R1206', undefined])
    expect(buildNetlist(chips.netlist, undefined).components.map((c) => c.footprint)).toEqual(['R1206', 'R1206', 'RES-ADJ'])
    expect(choices(chooseResistors(chips, 'through-hole'))).toEqual([undefined, undefined, undefined])
  })

  it('keeps the choices when the parts go back on a fresh grid', () => {
    const chips = chooseResistors(project, '1206')
    const grid = { ...chips, layout: createLayout(buildNetlist(chips.netlist, undefined)) }

    expect(buildNetlist(grid.netlist, undefined).components.map((c) => c.footprint)).toEqual(['R1206', 'R1206', 'RES-ADJ'])
  })
})
