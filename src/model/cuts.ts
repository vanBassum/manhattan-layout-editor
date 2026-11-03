import { highEdge, lowEdge, spanEnd, spanStart, type Axis, type Boundary } from './boundary'
import type { Island, Rect } from './types'

const EPS = 1e-6
const AXES = ['x', 'y'] as const

/** A straight isolation cut between the islands of two nets. */
export interface Cut extends Boundary {
  /** The two nets it separates, in alphabetical order. */
  nets: [string, string]
}

/**
 * Edges shared by islands of different nets, merged into straight cuts. Pieces on one line only
 * merge when they separate the same two nets: a line that runs past several islands is several
 * cuts, each moved on its own. A plane has no cuts.
 */
export function findCuts(islands: Island[]): Cut[] {
  const rects = islands.filter((island) => !island.plane).flatMap((island) => island.rects.map((rect) => ({ net: island.net, rect })))
  return AXES.flatMap((axis) => {
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
    return mergeCollinear(pieces, (a, b) => a.nets[0] === b.nets[0] && a.nets[1] === b.nets[1])
  })
}

/** A straight stretch of an island's outline. `inside` says on which side of the line the island lies. */
export interface IslandEdge extends Boundary {
  inside: 'low' | 'high'
}

/** The outline of one island, as straight edges that can be dragged. A plane has none. */
export function islandEdges(islands: Island[], net: string): IslandEdge[] {
  const island = islands.find((i) => i.net === net)
  if (!island || island.plane) return []
  const { rects } = island
  return AXES.flatMap((axis) => {
    const pieces: IslandEdge[] = rects.flatMap((r) => {
      const [from, to] = [spanStart(r, axis), spanEnd(r, axis)]
      const low = lowEdge(r, axis)
      const high = highEdge(r, axis)
      // Where another rectangle of the island lies just across a side, that side is inside the island.
      const coveredBelow = rects.filter((o) => lowEdge(o, axis) < low - EPS && highEdge(o, axis) > low - EPS)
      const coveredAbove = rects.filter((o) => lowEdge(o, axis) < high + EPS && highEdge(o, axis) > high + EPS)
      return [
        ...uncovered(from, to, coveredBelow, axis).map(([f, t]) => ({ axis, at: low, from: f, to: t, inside: 'high' as const })),
        ...uncovered(from, to, coveredAbove, axis).map(([f, t]) => ({ axis, at: high, from: f, to: t, inside: 'low' as const })),
      ]
    })
    return mergeCollinear(pieces, (a, b) => a.inside === b.inside)
  })
}

/** The stretches of from..to along the line that none of `covering` spans. */
function uncovered(from: number, to: number, covering: Rect[], axis: Axis): [number, number][] {
  const spans = covering.map((r) => [spanStart(r, axis), spanEnd(r, axis)]).sort((a, b) => a[0] - b[0])
  const open: [number, number][] = []
  let start = from
  for (const [spanFrom, spanTo] of spans) {
    if (spanFrom - start > EPS) open.push([start, Math.min(spanFrom, to)])
    start = Math.max(start, spanTo)
    if (start >= to - EPS) return open
  }
  if (to - start > EPS) open.push([start, to])
  return open
}

/** Joins pieces on one line that touch or overlap and are of the same kind. */
function mergeCollinear<T extends Boundary>(pieces: T[], sameKind: (a: T, b: T) => boolean): T[] {
  const sorted = [...pieces].sort((a, b) => a.at - b.at || a.from - b.from)
  const merged: T[] = []
  for (const piece of sorted) {
    const joins = merged.find((m) => Math.abs(m.at - piece.at) < EPS && sameKind(m, piece) && piece.from <= m.to + EPS)
    if (joins) joins.to = Math.max(joins.to, piece.to)
    else merged.push({ ...piece })
  }
  return merged
}
