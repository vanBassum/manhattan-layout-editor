import { snapToGrid } from './geometry'
import type { Island, Rect } from './types'

const EPS = 1e-6
/** No rectangle may shrink below this (mm) while a cut is dragged. */
const MIN_RECT_SIZE = 1

/**
 * A straight isolation cut between the islands of two nets: a vertical line at x = at (axis 'x')
 * or a horizontal one at y = at (axis 'y'), running from..to along that line.
 */
export interface Cut {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
  /** The two nets it separates, in alphabetical order. */
  nets: [string, string]
}

// Across the cut: the rectangle's near and far edge. Along the cut: its extent.
const lowEdge = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.x : r.y)
const highEdge = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.x + r.w : r.y + r.h)
const spanStart = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.y : r.x)
const spanEnd = (r: Rect, axis: Cut['axis']) => (axis === 'x' ? r.y + r.h : r.x + r.w)

const overlapAlong = (r: Rect, axis: Cut['axis'], from: number, to: number) =>
  Math.min(spanEnd(r, axis), to) - Math.max(spanStart(r, axis), from)

/**
 * Edges shared by islands of different nets, merged into straight cuts. Pieces on one line only
 * merge when they separate the same two nets: a line that runs past several islands is several
 * cuts, each moved on its own. A plane has no cuts.
 */
export function findCuts(islands: Island[]): Cut[] {
  const rects = islands.filter((island) => !island.plane).flatMap((island) => island.rects.map((rect) => ({ net: island.net, rect })))
  return (['x', 'y'] as const).flatMap((axis) => {
    const pieces: Cut[] = []
    for (const a of rects) {
      for (const b of rects) {
        if (a.net === b.net || Math.abs(highEdge(a.rect, axis) - lowEdge(b.rect, axis)) > EPS) continue
        const from = Math.max(spanStart(a.rect, axis), spanStart(b.rect, axis))
        const to = Math.min(spanEnd(a.rect, axis), spanEnd(b.rect, axis))
        const nets: Cut['nets'] = a.net < b.net ? [a.net, b.net] : [b.net, a.net]
        if (to - from > EPS) pieces.push({ axis, at: highEdge(a.rect, axis), from, to, nets })
      }
    }
    return mergeCollinear(pieces)
  })
}

const sameNets = (a: Cut, b: Cut) => a.nets[0] === b.nets[0] && a.nets[1] === b.nets[1]

function mergeCollinear(pieces: Cut[]): Cut[] {
  const sorted = [...pieces].sort((a, b) => a.at - b.at || a.from - b.from)
  const merged: Cut[] = []
  for (const piece of sorted) {
    const joins = merged.find((cut) => Math.abs(cut.at - piece.at) < EPS && sameNets(cut, piece) && piece.from <= cut.to + EPS)
    if (joins) joins.to = Math.max(joins.to, piece.to)
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

export type Side = 'left' | 'right' | 'top' | 'bottom'

/** A rectangle of another net with its `side` on an edge being dragged: the two share that cut. */
export interface CutNeighbour {
  net: string
  rectIndex: number
  rect: Rect
  side: Side
}

const OPPOSITE: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }

function sideValue(r: Rect, side: Side): number {
  switch (side) {
    case 'left':
      return r.x
    case 'right':
      return r.x + r.w
    case 'top':
      return r.y
    case 'bottom':
      return r.y + r.h
  }
}

/** Moves one edge of the rectangle, keeping the opposite edge and a minimum size. */
function withSide(r: Rect, side: Side, value: number): Rect {
  switch (side) {
    case 'left': {
      const x = Math.min(value, r.x + r.w - MIN_RECT_SIZE)
      return { ...r, x, w: r.x + r.w - x }
    }
    case 'right':
      return { ...r, w: Math.max(value - r.x, MIN_RECT_SIZE) }
    case 'top': {
      const y = Math.min(value, r.y + r.h - MIN_RECT_SIZE)
      return { ...r, y, h: r.y + r.h - y }
    }
    case 'bottom':
      return { ...r, h: Math.max(value - r.y, MIN_RECT_SIZE) }
  }
}

/** The dragged `sides` move by the pointer delta and land on the snap grid. */
export function resizeRect(r: Rect, sides: Side[], dx: number, dy: number, snap: number): Rect {
  return sides.reduce((resized, side) => {
    const delta = side === 'left' || side === 'right' ? dx : dy
    return withSide(resized, side, snapToGrid(sideValue(r, side) + delta, snap))
  }, r)
}

/** Rectangles of other nets that share a dragged side of `r`; dragging that cut moves both sides. */
export function cutNeighbours(islands: Island[], dragged: Island, r: Rect, sides: Side[]): CutNeighbour[] {
  if (dragged.plane) return []
  const others = islands.filter((island) => island.net !== dragged.net && !island.plane)
  return sides.flatMap((side) =>
    others.flatMap((island) =>
      island.rects.flatMap((other, rectIndex) => {
        const onEdge = Math.abs(sideValue(other, OPPOSITE[side]) - sideValue(r, side)) < EPS
        const alongEdge =
          side === 'top' || side === 'bottom'
            ? Math.min(r.x + r.w, other.x + other.w) - Math.max(r.x, other.x)
            : Math.min(r.y + r.h, other.y + other.h) - Math.max(r.y, other.y)
        return onEdge && alongEdge > EPS ? [{ net: island.net, rectIndex, rect: other, side: OPPOSITE[side] }] : []
      }),
    ),
  )
}

/** The neighbour's rectangle with its shared side moved to where the resized rectangle's side now is. */
export function followResize(neighbour: CutNeighbour, resized: Rect): Rect {
  return withSide(neighbour.rect, neighbour.side, sideValue(resized, OPPOSITE[neighbour.side]))
}
