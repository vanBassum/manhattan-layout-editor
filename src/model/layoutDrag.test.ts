import { describe, expect, it } from 'vitest'
import { findCuts, islandEdges } from './cuts'
import { draggedLayout } from './layoutDrag'
import type { Island, Layout, Placement } from './types'

const a: Island = { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }
const b: Island = { net: 'B', rects: [{ x: 0, y: 5, w: 10, h: 5 }] }
const r1: Placement = { ref: 'R1', x: 10, y: 10, rotation: 0 }
const r2: Placement = { ref: 'R2', x: 30, y: 10, rotation: 0 }
const layout: Layout = { islands: [a, b], placements: [r1, r2] }

const area = (island: Island) => island.rects.reduce((sum, r) => sum + r.w * r.h, 0)

describe('draggedLayout', () => {
  it('boundary: moves an outline edge onto the snap grid, taking copper from the neighbour', () => {
    const bottomOfA = islandEdges(layout.islands, 'A').find((e) => e.axis === 'y' && e.at === 5)!
    const drag = { kind: 'boundary' as const, boundary: bottomOfA, islands: layout.islands }

    const [movedA, movedB] = draggedLayout(layout, drag, { x: 0, y: 2.3 }, 1).islands

    expect([area(movedA), area(movedB)]).toEqual([70, 30])
  })

  it('island: moves the island so its first rectangle lands on the snap grid', () => {
    const drag = { kind: 'island' as const, net: 'A', rects: a.rects }

    expect(draggedLayout(layout, drag, { x: 1.3, y: 0.2 }, 1).islands).toEqual([
      { net: 'A', rects: [{ x: 1, y: 0, w: 10, h: 5 }] },
      b,
    ])
  })

  it('boundary: moves a cut onto the snap grid, with the islands on both sides', () => {
    const drag = { kind: 'boundary' as const, boundary: findCuts(layout.islands)[0], islands: layout.islands }

    expect(draggedLayout(layout, drag, { x: 0, y: -1.6 }, 0.5).islands).toEqual([
      { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 3.5 }] },
      { net: 'B', rects: [{ x: 0, y: 3.5, w: 10, h: 6.5 }] },
    ])
  })

  it('resize: moves the dragged side, and the side of the neighbour that shares it', () => {
    const drag = { kind: 'resize' as const, net: 'A', rectIndex: 0, sides: ['bottom' as const], islands: layout.islands }

    expect(draggedLayout(layout, drag, { x: 0, y: 2.2 }, 1).islands).toEqual([
      { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 7 }] },
      { net: 'B', rects: [{ x: 0, y: 7, w: 10, h: 3 }] },
    ])
  })

  it('lead: moves the lead end by the snapped delta, stored relative to the body', () => {
    const drag = { kind: 'lead' as const, ref: 'R1', pin: '1', origin: { x: 5, y: 10 } }

    expect(draggedLayout(layout, drag, { x: 0.6, y: 0 }, 0.5).placements).toEqual([{ ...r1, leads: { '1': { x: -4.5, y: 0 } } }, r2])
  })

  it('part: moves the part from where the drag started by the snapped delta', () => {
    const midDrag = { ...layout, placements: [{ ...r1, x: 11 }, r2] }
    const drag = { kind: 'part' as const, part: { placement: r1 } }

    expect(draggedLayout(midDrag, drag, { x: 2.2, y: -0.3 }, 1).placements).toEqual([{ ...r1, x: 12 }, r2])
  })

  it('group: moves parts by the delta that puts the first island on the snap grid', () => {
    const drag = { kind: 'group' as const, parts: [{ placement: r1 }], islands: [a] }

    expect(draggedLayout(layout, drag, { x: 1.3, y: 0.2 }, 1)).toEqual({
      islands: [{ net: 'A', rects: [{ x: 1, y: 0, w: 10, h: 5 }] }, b],
      placements: [{ ...r1, x: 11 }, r2],
    })
  })

  it('group: without islands, moves parts by the snapped delta', () => {
    const drag = { kind: 'group' as const, parts: [{ placement: r1 }], islands: [] }

    expect(draggedLayout(layout, drag, { x: 1.3, y: 0.6 }, 1).placements).toEqual([{ ...r1, x: 11, y: 11 }, r2])
  })
})
