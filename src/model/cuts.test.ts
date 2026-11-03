import { describe, expect, it } from 'vitest'
import { cutNeighbours, followResize, resizeRect } from './cuts'
import type { Island } from './types'

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
