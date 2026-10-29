// Up to v3, islands were stored as the copper itself, with an isolation gap between neighbors.
// From v4 on, islands touch and the cut is burned centered on their shared edge. Migrating grows
// every island by isolation/2 into the gap and puts its edges on the snap grid.

import { inflate, rectsOverlap, snapToGrid } from './geometry'
import type { Island, Project, Rect } from './types'

/** Grid for projects with snapping off. */
const FALLBACK_GRID = 0.1

export function migrateGappedIslands(project: Project): Project {
  const { isolation, snap } = project.settings
  const grid = snap > 0 ? snap : FALLBACK_GRID
  const grown = project.layout.islands.map((island) => ({
    ...island,
    rects: island.rects.map((r) => snapRect(inflate(r, isolation / 2), grid)),
  }))
  return { ...project, layout: { ...project.layout, islands: separateRoundingOverlaps(grown, grid) } }
}

function snapRect(r: Rect, grid: number): Rect {
  const left = snapToGrid(r.x, grid)
  const top = snapToGrid(r.y, grid)
  const right = Math.max(snapToGrid(r.x + r.w, grid), left + grid)
  const bottom = Math.max(snapToGrid(r.y + r.h, grid), top + grid)
  return { x: left, y: top, w: snapToGrid(right - left, grid), h: snapToGrid(bottom - top, grid) }
}

/**
 * Rounding can make neighbors of different nets overlap by a grid step; their shared edge then
 * moves to the middle of the overlap. Bigger overlaps were already there before migrating and are
 * left for the spacing check to report.
 */
function separateRoundingOverlaps(islands: Island[], grid: number): Island[] {
  const result = islands.map((island) => ({ ...island, rects: island.rects.map((r) => ({ ...r })) }))
  for (let a = 0; a < result.length; a++) {
    for (let b = a + 1; b < result.length; b++) {
      if (result[a].plane || result[b].plane || result[a].net === result[b].net) continue
      for (const ra of result[a].rects) {
        for (const rb of result[b].rects) {
          if (rectsOverlap(ra, rb)) splitSliver(ra, rb, grid)
        }
      }
    }
  }
  return result
}

/** Moves the edge shared by two rectangles that overlap by at most one grid step. Mutates both. */
function splitSliver(a: Rect, b: Rect, grid: number) {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (Math.min(xOverlap, yOverlap) > grid + 1e-6) return
  if (xOverlap <= yOverlap) {
    const [left, right] = a.x < b.x ? [a, b] : [b, a]
    if (left.x + left.w >= right.x + right.w) return
    const edge = snapToGrid((right.x + left.x + left.w) / 2, grid)
    const rightEnd = right.x + right.w
    left.w = snapToGrid(edge - left.x, grid)
    right.x = edge
    right.w = snapToGrid(rightEnd - edge, grid)
  } else {
    const [upper, lower] = a.y < b.y ? [a, b] : [b, a]
    if (upper.y + upper.h >= lower.y + lower.h) return
    const edge = snapToGrid((lower.y + upper.y + upper.h) / 2, grid)
    const lowerEnd = lower.y + lower.h
    upper.h = snapToGrid(edge - upper.y, grid)
    lower.y = edge
    lower.h = snapToGrid(lowerEnd - edge, grid)
  }
}
