import { describe, expect, it } from 'vitest'
import astable from '../examples/Astable multivibrator.json?raw'
import sziklai from '../examples/Sziklai emittor follower.json?raw'
import { alignedTarget, moveBoundary, resizeRect, type Boundary, type Side } from './boundary'
import { islandEdges } from './islandEdges'
import { findSpacingViolations, findSplitNets } from './layout'
import type { Island, Rect } from './types'

const area = (rects: Rect[]) => rects.reduce((sum, r) => sum + r.w * r.h, 0)
const islandOf = (islands: Island[], net: string) => islands.find((i) => i.net === net)!

describe('moveBoundary', () => {
  // Two pairs of islands side by side, with their cuts on one line at y = 5.
  const bias: Island = { net: 'BIAS', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
  const base: Island = { net: 'Q2_B', rects: [{ x: 0, y: 5, w: 10, h: 5 }] }
  const collector: Island = { net: 'Q2_C', rects: [{ x: 10, y: 0, w: 10, h: 5 }] }
  const emitter: Island = { net: 'Q2_E', rects: [{ x: 10, y: 5, w: 10, h: 5 }] }
  const islands = [bias, base, collector, emitter]
  // The bottom edge of BIAS, which it shares with Q2_B.
  const biasCut: Boundary = { axis: 'y', at: 5, from: 0, to: 10 }

  it('moves only the islands on both sides of a cut, not those further along its line', () => {
    const moved = moveBoundary(islands, biasCut, 7)
    expect(islandOf(moved, 'BIAS').rects).toEqual([{ x: 0, y: 0, w: 10, h: 7 }])
    expect(islandOf(moved, 'Q2_B').rects).toEqual([{ x: 0, y: 7, w: 10, h: 3 }])
    expect(islandOf(moved, 'Q2_C')).toEqual(collector)
    expect(islandOf(moved, 'Q2_E')).toEqual(emitter)
  })

  it('splits a rectangle that reaches past the stretch, so only the part along it moves', () => {
    // VCC runs over both BIAS and OUT; the cut between VCC and BIAS covers only x = 0..10.
    const vcc: Island = { net: 'VCC', rects: [{ x: 0, y: 0, w: 20, h: 5 }] }
    const low: Island = { net: 'BIAS', rects: [{ x: 0, y: 5, w: 10, h: 5 }] }
    const out: Island = { net: 'OUT', rects: [{ x: 10, y: 5, w: 10, h: 5 }] }
    const topOfBias = islandEdges([vcc, low, out], 'BIAS').find((e) => e.axis === 'y' && e.at === 5)!
    const moved = moveBoundary([vcc, low, out], topOfBias, 7)
    expect(islandOf(moved, 'VCC').rects).toEqual([{ x: 0, y: 0, w: 10, h: 7 }, { x: 10, y: 0, w: 10, h: 5 }])
    expect(islandOf(moved, 'BIAS').rects).toEqual([{ x: 0, y: 7, w: 10, h: 3 }])
    expect(islandOf(moved, 'OUT')).toEqual(out)
  })

  it('leaves the islands as they are when the boundary does not move', () => {
    expect(moveBoundary(islands, biasCut, 5)).toBe(islands)
  })

  it('leaves the copper it moves into at least 1 mm, so no island disappears', () => {
    expect(islandOf(moveBoundary(islands, biasCut, 30), 'Q2_B').rects).toEqual([{ x: 0, y: 9, w: 10, h: 1 }])
    expect(islandOf(moveBoundary(islands, biasCut, -30), 'BIAS').rects).toEqual([{ x: 0, y: 0, w: 10, h: 1 }])
  })

  it('does not move the other way when the copper it moves into is already thinner than 1 mm', () => {
    const thin: Island = { net: 'Q2_B', rects: [{ x: 0, y: 5, w: 10, h: 0.5 }] }
    expect(moveBoundary([bias, thin], biasCut, 6)).toEqual([bias, thin])
  })

  it('pulls a tab out of a stretch of an outline edge, taking the copper from the neighbour', () => {
    const bottomOfBias = islandEdges(islands, 'BIAS').find((e) => e.axis === 'y' && e.at === 5)!
    const moved = moveBoundary(islands, { ...bottomOfBias, from: 4, to: 6.5 }, 7.5)
    expect(area(islandOf(moved, 'BIAS').rects)).toBe(50 + 2.5 * 2.5)
    expect(area(islandOf(moved, 'Q2_B').rects)).toBe(50 - 2.5 * 2.5)
    expect(islandOf(moved, 'BIAS').rects).toContainEqual({ x: 4, y: 0, w: 2.5, h: 7.5 })
  })

  it('grows an island into free space up to the copper of another net, not over it', () => {
    const a: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
    const b: Island = { net: 'B', rects: [{ x: 2, y: 8, w: 4, h: 4 }] }
    const bottomOfA = islandEdges([a, b], 'A').find((e) => e.axis === 'y' && e.at === 5)!
    const moved = moveBoundary([a, b], bottomOfA, 20)
    expect(moved).toEqual([{ net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 8 }] }, b])
  })

  it('shrinks an island away from free space, leaving the space free', () => {
    const a: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
    const bottomOfA = islandEdges([a], 'A').find((e) => e.axis === 'y' && e.at === 5)!
    expect(moveBoundary([a], bottomOfA, 2)).toEqual([{ net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 2 }] }])
  })

  it('neither moves a plane nor is stopped by one: pads sit on top of it', () => {
    const plane: Island = { net: 'GND', plane: true, rects: [{ x: -20, y: -20, w: 60, h: 60 }] }
    const moved = moveBoundary([plane, ...islands], biasCut, 7)
    expect(moved[0]).toBe(plane)
    expect(islandOf(moved, 'BIAS').rects).toEqual([{ x: 0, y: 0, w: 10, h: 7 }])
  })
})

describe('resizeRect', () => {
  const pad: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }

  it('moves the dragged sides by the delta onto the snap grid and keeps the others', () => {
    expect(resizeRect([pad], 'A', 0, ['right', 'bottom'], { x: 2.3, y: 1.2 }, 1)[0].rects).toEqual([{ x: 0, y: 0, w: 12, h: 6 }])
    expect(resizeRect([pad], 'A', 0, ['left'], { x: -1.6, y: 9 }, 0.5)[0].rects).toEqual([{ x: -1.5, y: 0, w: 11.5, h: 5 }])
  })

  it('keeps at least the minimum size, holding the opposite side in place', () => {
    expect(resizeRect([pad], 'A', 0, ['left'], { x: 20, y: 0 }, 1)[0].rects).toEqual([{ x: 9, y: 0, w: 1, h: 5 }])
    expect(resizeRect([pad], 'A', 0, ['bottom'], { x: 0, y: -20 }, 1)[0].rects).toEqual([{ x: 0, y: 0, w: 10, h: 1 }])
  })

  it('moves the side of a neighbour that shares the dragged side, only along the rectangle', () => {
    const wide: Island = { net: 'B', rects: [{ x: -5, y: 5, w: 20, h: 5 }] }
    const [a, b] = resizeRect([pad, wide], 'A', 0, ['bottom'], { x: 0, y: 2 }, 1)
    expect(a.rects).toEqual([{ x: 0, y: 0, w: 10, h: 7 }])
    expect(b.rects).toEqual([{ x: 0, y: 7, w: 10, h: 3 }, { x: -5, y: 5, w: 5, h: 5 }, { x: 10, y: 5, w: 5, h: 5 }])
  })

  it('stops against a pad of another net instead of growing over it', () => {
    const other: Island = { net: 'B', rects: [{ x: 13, y: 0, w: 5, h: 5 }] }
    expect(resizeRect([pad, other], 'A', 0, ['right'], { x: 10, y: 0 }, 1)).toEqual([{ net: 'A', rects: [{ x: 0, y: 0, w: 13, h: 5 }] }, other])
  })

  it('keeps the index of the resized rectangle when another rectangle of its island is split', () => {
    // B's first rectangle runs under both of A's; resizing A's second one splits it.
    const a: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 5, h: 5 }, { x: 5, y: 0, w: 5, h: 5 }] }
    const b: Island = { net: 'B', rects: [{ x: 0, y: 5, w: 10, h: 5 }] }
    const [movedA] = resizeRect([a, b], 'A', 1, ['bottom'], { x: 0, y: 2 }, 1)
    expect(movedA.rects[1]).toEqual({ x: 5, y: 0, w: 5, h: 7 })
  })

  it('resizes a plane on its own: it is not cut from the pads on it', () => {
    const plane: Island = { net: 'GND', plane: true, rects: [{ x: 0, y: 0, w: 30, h: 30 }] }
    const onTop: Island = { net: 'B', rects: [{ x: 28, y: 5, w: 5, h: 5 }] }
    expect(resizeRect([plane, onTop], 'GND', 0, ['right'], { x: 5, y: 0 }, 1)).toEqual([
      { ...plane, rects: [{ x: 0, y: 0, w: 35, h: 30 }] },
      onTop,
    ])
    expect(resizeRect([plane, onTop], 'GND', 0, ['right'], { x: -50, y: 0 }, 1)[0].rects).toEqual([{ x: 0, y: 0, w: 1, h: 30 }])
  })
})

describe('alignedTarget', () => {
  const a: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
  const bottomOfA: Boundary = { axis: 'y', at: 5, from: 0, to: 10 }
  // Further along the board, with bottom edges at 7.3 and 7.6.
  const short: Island = { net: 'B', rects: [{ x: 20, y: 0, w: 5, h: 7.3 }] }
  const long: Island = { net: 'C', rects: [{ x: 30, y: 0, w: 5, h: 7.6 }] }

  it('snaps to the grid when no edge is near', () => {
    expect(alignedTarget([a], bottomOfA, { x: 4, y: 1.3 }, 1, 0.5)).toEqual({ at: 6, aligned: false })
  })

  it('lines up with a parallel edge within the tolerance rather than with the grid', () => {
    expect(alignedTarget([a, short], bottomOfA, { x: 0, y: 2.1 }, 1, 0.5)).toEqual({ at: 7.3, aligned: true })
  })

  it('lines up with the nearest of two edges within the tolerance', () => {
    expect(alignedTarget([a, short, long], bottomOfA, { x: 0, y: 2.5 }, 1, 0.5)).toEqual({ at: 7.6, aligned: true })
  })

  it('snaps to the grid when the edges are further away than the tolerance', () => {
    expect(alignedTarget([a, short, long], bottomOfA, { x: 0, y: 1.2 }, 1, 0.5)).toEqual({ at: 6, aligned: false })
  })

  it('does not line up with the edge being dragged', () => {
    expect(alignedTarget([a], bottomOfA, { x: 0, y: 0.2 }, 0.3, 0.5)).toEqual({ at: 5.1, aligned: false })
  })

  it('is not aligned with an edge that copper in the way keeps it from reaching', () => {
    const below: Island = { net: 'D', rects: [{ x: 0, y: 8, w: 10, h: 1 }] }
    expect(alignedTarget([a, below], bottomOfA, { x: 0, y: 3.9 }, 1, 0.5)).toEqual({ at: 9, aligned: false })
  })
})

/**
 * The rules every drag of a boundary keeps, checked on whole boards: no two nets overlap, and
 * islands that do not touch the boundary stay exactly as they were. An island on the boundary may
 * fall apart, when the copper taken from it was what joined its pieces; the board shows that.
 */
describe('moving any boundary of a board', () => {
  const islandsOf = (file: string): Island[] => JSON.parse(file).project.layout.islands
  const manhattan: Island[] = [
    { net: 'GND', plane: true, rects: [{ x: -10, y: -10, w: 60, h: 40 }] },
    { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 4 }] },
    { net: 'B', rects: [{ x: 10, y: 0, w: 6, h: 4 }, { x: 10, y: 4, w: 3, h: 6 }] },
    { net: 'C', rects: [{ x: 20, y: 0, w: 4, h: 4 }] },
  ]
  const boards = { astable: islandsOf(astable), sziklai: islandsOf(sziklai), manhattan }
  const offsets = [-50, -5, -2, -0.5, 0.5, 2, 5, 50]

  const touches = (island: Island, b: Boundary) =>
    island.rects.some((r) => {
      const [low, high, start, end] = b.axis === 'x' ? [r.x, r.x + r.w, r.y, r.y + r.h] : [r.y, r.y + r.h, r.x, r.x + r.w]
      return (Math.abs(low - b.at) < 1e-6 || Math.abs(high - b.at) < 1e-6) && Math.min(end, b.to) - Math.max(start, b.from) > 1e-6
    })

  const expectRulesKept = (before: Island[], after: Island[], boundary: Boundary) => {
    expect(findSpacingViolations(after)).toEqual(findSpacingViolations(before))
    const splitBefore = findSplitNets(before)
    for (const net of findSplitNets(after)) {
      if (!splitBefore.has(net)) expect(touches(before.find((i) => i.net === net)!, boundary)).toBe(true)
    }
    before.forEach((island, k) => {
      if (island.plane || !touches(island, boundary)) expect(after[k]).toEqual(island)
    })
  }

  for (const [name, islands] of Object.entries(boards)) {
    it(`${name}: dragging an outline edge, or a tab out of it, keeps the rules`, () => {
      for (const island of islands) {
        for (const edge of islandEdges(islands, island.net)) {
          const tab = { ...edge, from: edge.from + (edge.to - edge.from) / 3, to: edge.to - (edge.to - edge.from) / 3 }
          for (const offset of offsets) {
            expectRulesKept(islands, moveBoundary(islands, edge, edge.at + offset), edge)
            expectRulesKept(islands, moveBoundary(islands, tab, tab.at + offset), tab)
          }
        }
      }
    })

    it(`${name}: resizing a rectangle keeps the rules`, () => {
      const sides: Side[][] = [['left'], ['right'], ['top'], ['bottom'], ['right', 'bottom'], ['left', 'top']]
      for (const island of islands.filter((i) => !i.plane)) {
        island.rects.forEach((_, rectIndex) => {
          for (const dragged of sides) {
            for (const offset of offsets) {
              const after = resizeRect(islands, island.net, rectIndex, dragged, { x: offset, y: offset }, 0.5)
              expect(findSpacingViolations(after)).toEqual(findSpacingViolations(islands))
            }
          }
        })
      }
    })
  }
})
