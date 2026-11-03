import { describe, expect, it } from 'vitest'
import { cutNeighbours, findCuts, followResize, moveCut, resizeRect } from './cuts'
import type { Island } from './types'

describe('findCuts', () => {
  // Two pairs of islands side by side, with their cuts on one line at y = 5.
  const bias: Island = { net: 'BIAS', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
  const base: Island = { net: 'Q2_B', rects: [{ x: 0, y: 5, w: 10, h: 5 }] }
  const collector: Island = { net: 'Q2_C', rects: [{ x: 10, y: 0, w: 10, h: 5 }] }
  const emitter: Island = { net: 'Q2_E', rects: [{ x: 10, y: 5, w: 10, h: 5 }] }
  const islands = [bias, base, collector, emitter]

  it('keeps cuts on one line apart when they separate other nets', () => {
    const horizontal = findCuts(islands).filter((cut) => cut.axis === 'y')
    expect(horizontal).toEqual([
      { axis: 'y', at: 5, from: 0, to: 10, nets: ['BIAS', 'Q2_B'] },
      { axis: 'y', at: 5, from: 10, to: 20, nets: ['Q2_C', 'Q2_E'] },
    ])
  })

  it('merges the pieces of one cut between the same two nets', () => {
    const split: Island = { net: 'Q2_B', rects: [{ x: 0, y: 5, w: 4, h: 5 }, { x: 4, y: 5, w: 6, h: 5 }] }
    expect(findCuts([bias, split]).filter((cut) => cut.axis === 'y')).toEqual([{ axis: 'y', at: 5, from: 0, to: 10, nets: ['BIAS', 'Q2_B'] }])
  })

  it('moves only the islands on both sides of the dragged cut', () => {
    const cut = findCuts(islands).find((c) => c.axis === 'y' && c.nets[0] === 'BIAS')!
    const moved = moveCut(islands, cut, 7)
    expect(moved.find((i) => i.net === 'BIAS')!.rects).toEqual([{ x: 0, y: 0, w: 10, h: 7 }])
    expect(moved.find((i) => i.net === 'Q2_B')!.rects).toEqual([{ x: 0, y: 7, w: 10, h: 3 }])
    expect(moved.find((i) => i.net === 'Q2_C')).toEqual(collector)
    expect(moved.find((i) => i.net === 'Q2_E')).toEqual(emitter)
  })

  it('splits a rectangle that reaches past the cut, so only the part along it moves', () => {
    // VCC runs over both BIAS and OUT; the cut between VCC and BIAS covers only x = 0..10.
    const vcc: Island = { net: 'VCC', rects: [{ x: 0, y: 0, w: 20, h: 5 }] }
    const low: Island = { net: 'BIAS', rects: [{ x: 0, y: 5, w: 10, h: 5 }] }
    const out: Island = { net: 'OUT', rects: [{ x: 10, y: 5, w: 10, h: 5 }] }
    const cut = findCuts([vcc, low, out]).find((c) => c.axis === 'y' && c.nets.includes('BIAS'))!
    const moved = moveCut([vcc, low, out], cut, 7)
    expect(moved.find((i) => i.net === 'VCC')!.rects).toEqual([{ x: 0, y: 0, w: 10, h: 7 }, { x: 10, y: 0, w: 10, h: 5 }])
    expect(moved.find((i) => i.net === 'BIAS')!.rects).toEqual([{ x: 0, y: 7, w: 10, h: 3 }])
    expect(moved.find((i) => i.net === 'OUT')).toEqual(out)
  })

  it('leaves the islands as they are when the cut does not move', () => {
    const cut = findCuts(islands).find((c) => c.axis === 'y' && c.nets[0] === 'BIAS')!
    expect(moveCut(islands, cut, 5)).toBe(islands)
  })
})

describe('resizeRect', () => {
  const rect = { x: 0, y: 0, w: 10, h: 5 }

  it('moves the dragged sides by the delta onto the snap grid and keeps the others', () => {
    expect(resizeRect(rect, ['right', 'bottom'], 2.3, 1.2, 1)).toEqual({ x: 0, y: 0, w: 12, h: 6 })
    expect(resizeRect(rect, ['left'], -1.6, 9, 0.5)).toEqual({ x: -1.5, y: 0, w: 11.5, h: 5 })
  })

  it('keeps at least the minimum size, holding the opposite side in place', () => {
    expect(resizeRect(rect, ['left'], 20, 0, 1)).toEqual({ x: 9, y: 0, w: 1, h: 5 })
    expect(resizeRect(rect, ['bottom'], 0, -20, 1)).toEqual({ x: 0, y: 0, w: 10, h: 1 })
  })
})

describe('cutNeighbours', () => {
  const a: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
  const b: Island = { net: 'B', rects: [{ x: 10, y: 2, w: 5, h: 5 }, { x: 0, y: 5, w: 4, h: 5 }] }
  const plane: Island = { net: 'GND', plane: true, rects: [{ x: 10, y: -10, w: 20, h: 20 }] }

  it('finds the rectangles of other nets on the dragged sides, with their side facing it', () => {
    expect(cutNeighbours([a, b, plane], a, a.rects[0], ['right', 'bottom'])).toEqual([
      { net: 'B', rectIndex: 0, rect: b.rects[0], side: 'left' },
      { net: 'B', rectIndex: 1, rect: b.rects[1], side: 'top' },
    ])
  })

  it('finds none for a plane: its rectangles are not cut from their neighbours', () => {
    expect(cutNeighbours([a, b, plane], plane, plane.rects[0], ['left'])).toEqual([])
  })
})

describe('followResize', () => {
  it("moves the neighbour's shared side to the resized rectangle's side", () => {
    const neighbour = { net: 'B', rectIndex: 0, rect: { x: 10, y: 0, w: 5, h: 5 }, side: 'left' as const }

    expect(followResize(neighbour, { x: 0, y: 0, w: 12, h: 5 })).toEqual({ x: 12, y: 0, w: 3, h: 5 })
  })
})
