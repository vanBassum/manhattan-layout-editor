import { describe, expect, it } from 'vitest'
import { islandEdges, moveIslandEdge } from './raster'
import type { Island } from './types'

describe('moveIslandEdge', () => {
  const islands: Island[] = [
    { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] },
    { net: 'B', rects: [{ x: 0, y: 5, w: 10, h: 5 }] },
  ]
  const bottomOfA = islandEdges(islands, 'A').find((e) => e.axis === 'y' && e.at === 5)!

  it('pulls a tab out of a stretch of the edge, taking the copper from the neighbour', () => {
    const after = moveIslandEdge(islands, 'A', { ...bottomOfA, from: 4, to: 6.5 }, 7.5)

    const area = (island: Island) => island.rects.reduce((sum, r) => sum + r.w * r.h, 0)
    const [a, b] = after
    expect(area(a)).toBe(50 + 2.5 * 2.5)
    expect(area(b)).toBe(50 - 2.5 * 2.5)
    expect(a.rects).toContainEqual({ x: 4, y: 5, w: 2.5, h: 2.5 })
  })
})
