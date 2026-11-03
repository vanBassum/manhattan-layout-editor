import { describe, expect, it } from 'vitest'
import { findCuts, islandEdges } from './cuts'
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

  it('finds none along a plane', () => {
    const plane: Island = { net: 'GND', plane: true, rects: [{ x: 0, y: 10, w: 10, h: 5 }] }
    expect(findCuts([base, plane])).toEqual([])
  })
})

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
