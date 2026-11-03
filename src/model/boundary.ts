import { snapToGrid } from './geometry'
import type { Island, Point, Rect } from './types'

const EPS = 1e-6
/** No rectangle may shrink below this (mm) while a boundary is dragged. */
const MIN_RECT_SIZE = 1

export type Axis = 'x' | 'y'

/**
 * A straight stretch of the line between copper and something else: a vertical line at x = at
 * (axis 'x') or a horizontal one at y = at (axis 'y'), running from..to along that line.
 */
export interface Boundary {
  axis: Axis
  at: number
  from: number
  to: number
}

// Across the boundary: the rectangle's near and far edge. Along it: the rectangle's extent.
export const lowEdge = (r: Rect, axis: Axis) => (axis === 'x' ? r.x : r.y)
export const highEdge = (r: Rect, axis: Axis) => (axis === 'x' ? r.x + r.w : r.y + r.h)
export const spanStart = (r: Rect, axis: Axis) => (axis === 'x' ? r.y : r.x)
export const spanEnd = (r: Rect, axis: Axis) => (axis === 'x' ? r.y + r.h : r.x + r.w)

const overlapAlong = (r: Rect, axis: Axis, from: number, to: number) =>
  Math.min(spanEnd(r, axis), to) - Math.max(spanStart(r, axis), from)

const touches = (r: Rect, { axis, at, from, to }: Boundary) =>
  (Math.abs(lowEdge(r, axis) - at) < EPS || Math.abs(highEdge(r, axis) - at) < EPS) && overlapAlong(r, axis, from, to) > EPS

/**
 * Moves the boundary to `target`. Every rectangle with an edge on it follows along the stretch:
 * one that reaches past the stretch's ends is split there, so its island gets a notch or a tab.
 * The copper on the side it moves into keeps at least MIN_RECT_SIZE, and copper that is only in
 * the way, not on the boundary, stops it, so no island overlaps another, none opens a gap with
 * its neighbour, and only the islands on the boundary change. Planes are not cut from the
 * islands on top of them, so they neither move nor stop it.
 */
export function moveBoundary(islands: Island[], boundary: Boundary, target: number): Island[] {
  const value = reachableTarget(islands, boundary, target)
  // Nothing to split when the boundary stays put, e.g. a click without a drag.
  if (Math.abs(value - boundary.at) < EPS) return islands
  return islands.map((island) => (island.plane ? island : { ...island, rects: followBoundary(island.rects, boundary, value) }))
}

/** Where the boundary lands on the snap grid when the pointer has moved by `delta`. */
function draggedTarget({ axis, at }: Boundary, delta: Point, snap: number): number {
  return snapToGrid(at + (axis === 'x' ? delta.x : delta.y), snap)
}

/** Where a dragged boundary lands, and whether it lines up with another edge there. */
export interface AlignedTarget {
  at: number
  aligned: boolean
}

/**
 * Where the boundary lands when the pointer has moved by `delta`: on the nearest edge parallel to
 * it within `tolerance`, so islands line up with each other, else on the snap grid. `aligned` only
 * holds when the boundary can actually reach that edge.
 */
export function alignedTarget(islands: Island[], boundary: Boundary, delta: Point, snap: number, tolerance: number): AlignedTarget {
  const wanted = boundary.at + (boundary.axis === 'x' ? delta.x : delta.y)
  const nearest = alignmentLines(islands, boundary)
    .filter((line) => Math.abs(line - wanted) <= tolerance)
    .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0]
  if (nearest === undefined) return { at: snapToGrid(wanted, snap), aligned: false }
  return { at: nearest, aligned: Math.abs(reachableTarget(islands, boundary, nearest) - nearest) < EPS }
}

/** The edges parallel to the boundary that stay put while it moves: all but the islands' edges on it. */
function alignmentLines(islands: Island[], boundary: Boundary): number[] {
  const { axis, at, from, to } = boundary
  const movesAlong = (r: Rect, edge: number) => Math.abs(edge - at) < EPS && overlapAlong(r, axis, from, to) > EPS
  return islands.flatMap((island) =>
    island.rects.flatMap((r) => [lowEdge(r, axis), highEdge(r, axis)].filter((edge) => island.plane || !movesAlong(r, edge))),
  )
}

/** How far towards `target` the boundary can go; never past where it is in the other direction. */
function reachableTarget(islands: Island[], { axis, at, from, to }: Boundary, target: number): number {
  const forward = target > at
  let limit = target
  for (const island of islands) {
    if (island.plane) continue
    for (const r of island.rects) {
      if (overlapAlong(r, axis, from, to) <= EPS) continue
      const near = forward ? lowEdge(r, axis) : highEdge(r, axis)
      const far = forward ? highEdge(r, axis) : lowEdge(r, axis)
      const ahead = forward ? near > at - EPS : near < at + EPS
      if (!ahead) continue
      const stop = Math.abs(near - at) < EPS ? (forward ? far - MIN_RECT_SIZE : far + MIN_RECT_SIZE) : near
      limit = forward ? Math.min(limit, stop) : Math.max(limit, stop)
    }
  }
  return forward ? Math.max(limit, at) : Math.min(limit, at)
}

/**
 * The rectangles with their edges on the boundary moved to `value` along the stretch. A moved
 * rectangle keeps its index, so a selected rectangle stays selected; the pieces split off it
 * past the stretch's ends go at the end.
 */
function followBoundary(rects: Rect[], boundary: Boundary, value: number): Rect[] {
  const { axis, from, to } = boundary
  const moved = rects.map((r) => (touches(r, boundary) ? withEdgeAt(clipAlong(r, axis, from, to), boundary, value) : r))
  const splitOff = rects.filter((r) => touches(r, boundary)).flatMap((r) => outsideAlong(r, axis, from, to))
  return [...moved, ...splitOff]
}

function clipAlong(r: Rect, axis: Axis, from: number, to: number): Rect {
  return withSpan(r, axis, Math.max(spanStart(r, axis), from), Math.min(spanEnd(r, axis), to))
}

/** The parts of the rectangle before `from` and after `to` along the line. */
function outsideAlong(r: Rect, axis: Axis, from: number, to: number): Rect[] {
  const pieces: Rect[] = []
  if (from - spanStart(r, axis) > EPS) pieces.push(withSpan(r, axis, spanStart(r, axis), from))
  if (spanEnd(r, axis) - to > EPS) pieces.push(withSpan(r, axis, to, spanEnd(r, axis)))
  return pieces
}

function withSpan(r: Rect, axis: Axis, start: number, end: number): Rect {
  return axis === 'x' ? { ...r, y: start, h: end - start } : { ...r, x: start, w: end - start }
}

function withEdgeAt(r: Rect, { axis, at }: Boundary, value: number): Rect {
  const low = lowEdge(r, axis)
  const high = highEdge(r, axis)
  const [newLow, newHigh] = Math.abs(low - at) < EPS ? [value, high] : [low, value]
  return axis === 'x' ? { ...r, x: newLow, w: newHigh - newLow } : { ...r, y: newLow, h: newHigh - newLow }
}

export type Side = 'left' | 'right' | 'top' | 'bottom'

/** The boundary along one side of a rectangle. */
function sideBoundary(r: Rect, side: Side): Boundary {
  const axis = side === 'left' || side === 'right' ? 'x' : 'y'
  const at = side === 'left' || side === 'top' ? lowEdge(r, axis) : highEdge(r, axis)
  return { axis, at, from: spanStart(r, axis), to: spanEnd(r, axis) }
}

/**
 * Resizes one rectangle of an island: each dragged side moves by the pointer delta onto the snap
 * grid, as the boundary along that side, so the copper across it follows.
 */
export function resizeRect(islands: Island[], net: string, rectIndex: number, sides: Side[], delta: Point, snap: number): Island[] {
  return sides.reduce((current, side) => {
    const island = current.find((i) => i.net === net)!
    const boundary = sideBoundary(island.rects[rectIndex], side)
    const target = draggedTarget(boundary, delta, snap)
    if (!island.plane) return moveBoundary(current, boundary, target)
    // A plane is not cut from the pads on it: only its own rectangle changes.
    const rects = island.rects.map((r, k) => (k === rectIndex ? withEdgeAt(r, boundary, keepMinimumSize(r, boundary, target)) : r))
    return current.map((i) => (i === island ? { ...island, rects } : i))
  }, islands)
}

function keepMinimumSize(r: Rect, { axis, at }: Boundary, target: number): number {
  const low = lowEdge(r, axis)
  const high = highEdge(r, axis)
  return Math.abs(low - at) < EPS ? Math.min(target, high - MIN_RECT_SIZE) : Math.max(target, low + MIN_RECT_SIZE)
}
