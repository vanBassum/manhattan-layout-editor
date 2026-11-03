import { describe, expect, it } from 'vitest'
import { islandEdges } from './islandEdges'
import type { Island } from './types'

describe('islandEdges', () => {
  it('outlines an island built from several rectangles as one shape', () => {
    // An L: a bar on top and a leg below its left end.
    const l: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }, { x: 0, y: 5, w: 4, h: 5 }] }
    expect(islandEdges([l], 'A')).toEqual([
      { axis: 'x', at: 0, from: 0, to: 10, inside: 'high' },
      { axis: 'x', at: 4, from: 5, to: 10, inside: 'low' },
      { axis: 'x', at: 10, from: 0, to: 5, inside: 'low' },
      { axis: 'y', at: 0, from: 0, to: 10, inside: 'high' },
      { axis: 'y', at: 5, from: 4, to: 10, inside: 'low' },
      { axis: 'y', at: 10, from: 0, to: 4, inside: 'low' },
    ])
  })

  it('runs along the neighbours of other nets as well as along free space', () => {
    const a: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
    const b: Island = { net: 'B', rects: [{ x: 0, y: 5, w: 4, h: 5 }] }
    expect(islandEdges([a, b], 'A').filter((e) => e.axis === 'y' && e.at === 5)).toEqual([{ axis: 'y', at: 5, from: 0, to: 10, inside: 'low' }])
  })

  it('finds none for a plane', () => {
    expect(islandEdges([{ net: 'GND', plane: true, rects: [{ x: 0, y: 0, w: 10, h: 5 }] }], 'GND')).toEqual([])
  })
})
