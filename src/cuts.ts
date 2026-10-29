import type { Island, Rect } from './types'

const EPS = 1e-6
/** No rectangle may shrink below this (mm) while a cut is dragged. */
export const MIN_RECT_SIZE = 1

/**
 * A straight isolation cut between islands of different nets: a vertical line at x = at
 * (axis 'x') or a horizontal one at y = at (axis 'y'), running from..to along that line.
 */
export interface Cut {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

// Across the cut: the rectangle's near and far edge. Along the cut: its extent.
const lowEdge = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.x : r.y)
const highEdge = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.x + r.w : r.y + r.h)
const spanStart = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.y : r.x)
const spanEnd = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.y + r.h : r.x + r.w)

const overlapAlong = (r: Rect, axis: Cut['axis'], from: number, to: number) =>
  Math.min(spanEnd(r, axis), to) - Math.max(spanStart(r, axis), from)

/** Edges shared by islands of different nets, merged into straight cuts. A plane has no cuts. */
export function findCuts(islands: Island[]): Cut[] {
  const rects = islands.filter((island) => !island.plane).flatMap((island) => island.rects.map((rect) => ({ net: island.net, rect })))
  return (['x', 'y'] as const).flatMap((axis) => {
    const pieces: Cut[] = []
    for (const a of rects) {
      for (const b of rects) {
        if (a.net === b.net || Math.abs(highEdge(a.rect, axis) - lowEdge(b.rect, axis)) > EPS) continue
        const from = Math.max(spanStart(a.rect, axis), spanStart(b.rect, axis))
        const to = Math.min(spanEnd(a.rect, axis), spanEnd(b.rect, axis))
        if (to - from > EPS) pieces.push({ axis, at: highEdge(a.rect, axis), from, to })
      }
    }
    return mergeCollinear(pieces)
  })
}

function mergeCollinear(pieces: Cut[]): Cut[] {
  const sorted = [...pieces].sort((a, b) => a.at - b.at || a.from - b.from)
  const merged: Cut[] = []
  for (const piece of sorted) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.at - piece.at) < EPS && piece.from <= last.to + EPS) last.to = Math.max(last.to, piece.to)
    else merged.push({ ...piece })
  }
  return merged
}

/**
 * Moves the cut to `target`, together with every rectangle edge on its line that it touches, so
 * both sides follow and no gap or overlap opens. Rectangles keep at least MIN_RECT_SIZE.
 */
export function moveCut(islands: Island[], cut: Cut, target: number): Island[] {
  const { axis, at } = cut
  const rects = islands.filter((island) => !island.plane).flatMap((island) => island.rects)
  const onLine = (r: Rect) => Math.abs(lowEdge(r, axis) - at) < EPS || Math.abs(highEdge(r, axis) - at) < EPS

  // Grow the range to every edge on the line that overlaps it: an edge reaching past the cut
  // moves as a whole, so whatever it touches there has to move along.
  let { from, to } = cut
  for (let grown = true; grown; ) {
    grown = false
    for (const r of rects) {
      if (!onLine(r) || overlapAlong(r, axis, from, to) <= EPS) continue
      if (spanStart(r, axis) < from - EPS || spanEnd(r, axis) > to + EPS) {
        from = Math.min(from, spanStart(r, axis))
        to = Math.max(to, spanEnd(r, axis))
        grown = true
      }
    }
  }

  const moves = (r: Rect) => onLine(r) && overlapAlong(r, axis, from, to) > EPS
  let lowest = -Infinity
  let highest = Infinity
  for (const r of rects.filter(moves)) {
    if (Math.abs(lowEdge(r, axis) - at) < EPS) highest = Math.min(highest, highEdge(r, axis) - MIN_RECT_SIZE)
    else lowest = Math.max(lowest, lowEdge(r, axis) + MIN_RECT_SIZE)
  }
  const value = Math.min(Math.max(target, lowest), highest)

  return islands.map((island) =>
    island.plane ? island : { ...island, rects: island.rects.map((r) => (moves(r) ? withEdgeAt(r, axis, at, value) : r)) },
  )
}

function withEdgeAt(r: Rect, axis: Cut['axis'], at: number, value: number): Rect {
  const low = lowEdge(r, axis)
  const high = highEdge(r, axis)
  const [newLow, newHigh] = Math.abs(low - at) < EPS ? [value, high] : [low, value]
  return axis === 'x' ? { ...r, x: newLow, w: newHigh - newLow } : { ...r, y: newLow, h: newHigh - newLow }
}
