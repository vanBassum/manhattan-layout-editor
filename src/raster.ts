import type { Island, Rect } from './types'

const EPS = 1e-6

/**
 * The plane cut into cells along every x and y coordinate that matters (rectangle edges, cut
 * lines), so any shape built from them is a set of whole cells. `owner` holds an index per cell,
 * or -1 for no copper.
 */
export interface Grid {
  xs: number[]
  ys: number[]
  owner: Int32Array
}

export type Axis = 'x' | 'y'

export const uniqueSorted = (values: number[]) =>
  [...values].sort((a, b) => a - b).filter((v, k, all) => k === 0 || v - all[k - 1] > EPS)

export const indexOf = (values: number[], v: number) => values.findIndex((u) => Math.abs(u - v) < EPS)

export const columns = (grid: Grid) => grid.xs.length - 1
export const rows = (grid: Grid) => grid.ys.length - 1
const cell = (grid: Grid, i: number, j: number) => j * columns(grid) + i

/**
 * Index helpers for code that works across or along a line: for a vertical line (axis 'x') the
 * cross direction is x and the along direction is y; for a horizontal line it is the other way.
 */
export function oriented(grid: Grid, axis: Axis) {
  return {
    across: axis === 'x' ? grid.xs : grid.ys,
    along: axis === 'x' ? grid.ys : grid.xs,
    cell: (a: number, b: number) => (axis === 'x' ? cell(grid, a, b) : cell(grid, b, a)),
  }
}

/** The cells for which `isCell` holds, as few rectangles: runs per row, stacked where they line up. */
export function cellsToRects(grid: Grid, isCell: (index: number) => boolean): Rect[] {
  const { xs, ys } = grid
  const rects: Rect[] = []
  let growing = new Map<string, Rect>()
  for (let j = 0; j < rows(grid); j++) {
    const next = new Map<string, Rect>()
    for (let i = 0; i < columns(grid); ) {
      if (!isCell(cell(grid, i, j))) {
        i++
        continue
      }
      const start = i
      while (i < columns(grid) && isCell(cell(grid, i, j))) i++
      const key = `${start}:${i}`
      const above = growing.get(key)
      if (above) {
        above.h = ys[j + 1] - above.y
        next.set(key, above)
      } else {
        const rect = { x: xs[start], y: ys[j], w: xs[i] - xs[start], h: ys[j + 1] - ys[j] }
        rects.push(rect)
        next.set(key, rect)
      }
    }
    growing = next
  }
  return rects
}

// ---------- Knife with polygons: an island is one shape with draggable edges ----------

function rasterize(islands: Island[], extraXs: number[], extraYs: number[]): Grid {
  const rects = islands.flatMap((island) => island.rects)
  const grid: Grid = {
    xs: uniqueSorted([...rects.flatMap((r) => [r.x, r.x + r.w]), ...extraXs]),
    ys: uniqueSorted([...rects.flatMap((r) => [r.y, r.y + r.h]), ...extraYs]),
    owner: new Int32Array(0),
  }
  grid.owner = new Int32Array(Math.max(0, columns(grid) * rows(grid))).fill(-1)
  islands.forEach((island, k) => {
    for (const r of island.rects) {
      for (let j = indexOf(grid.ys, r.y); j < indexOf(grid.ys, r.y + r.h); j++) {
        for (let i = indexOf(grid.xs, r.x); i < indexOf(grid.xs, r.x + r.w); i++) {
          // Overlapping islands are a reported problem; here the first one keeps the cell.
          if (grid.owner[cell(grid, i, j)] === -1) grid.owner[cell(grid, i, j)] = k
        }
      }
    }
  })
  return grid
}

/** A straight stretch of an island's outline. `inside` says on which side of the line the island lies. */
export interface IslandEdge {
  axis: Axis
  at: number
  from: number
  to: number
  inside: 'low' | 'high'
}

/** The outline of one island, as straight edges that can be dragged. Planes are not included. */
export function islandEdges(islands: Island[], net: string): IslandEdge[] {
  const plain = islands.filter((island) => !island.plane)
  const k = plain.findIndex((island) => island.net === net)
  if (k === -1) return []
  const grid = rasterize(plain, [], [])
  return (['x', 'y'] as const).flatMap((axis) => {
    const { across, along, cell: at } = oriented(grid, axis)
    const edges: IslandEdge[] = []
    for (let a = 0; a < across.length; a++) {
      let run: IslandEdge | undefined
      for (let b = 0; b < along.length - 1; b++) {
        const low = a > 0 ? grid.owner[at(a - 1, b)] : -1
        const high = a < across.length - 1 ? grid.owner[at(a, b)] : -1
        const inside = low === k && high !== k ? 'low' : high === k && low !== k ? 'high' : undefined
        if (inside && run?.inside === inside && Math.abs(run.to - along[b]) < EPS) {
          run.to = along[b + 1]
        } else {
          run = inside ? { axis, at: across[a], from: along[b], to: along[b + 1], inside } : undefined
          if (run) edges.push(run)
        }
      }
    }
    return edges
  })
}

/**
 * Moves one edge of an island's outline, or a stretch of it (`from`..`to` narrower than the
 * outline's edge pulls out a tab), to `target`. Growing takes the cells from whatever lies there;
 * shrinking hands them to the island across the edge, so no gap opens between nets. Returns the
 * islands unchanged when the island would disappear.
 */
export function moveIslandEdge(islands: Island[], net: string, edge: IslandEdge, target: number): Island[] {
  const plain = islands.filter((island) => !island.plane)
  const k = plain.findIndex((island) => island.net === net)
  if (k === -1) return islands
  const [acrossLines, alongLines] = [[edge.at, target], [edge.from, edge.to]]
  const grid = rasterize(plain, edge.axis === 'x' ? acrossLines : alongLines, edge.axis === 'y' ? acrossLines : alongLines)
  const { across, along, cell: at } = oriented(grid, edge.axis)
  const a0 = indexOf(across, edge.at)
  const a1 = indexOf(across, target)
  const outward = edge.inside === 'low' ? target > edge.at : target < edge.at
  for (let b = 0; b < along.length - 1; b++) {
    if (along[b] < edge.from - EPS || along[b + 1] > edge.to + EPS) continue
    // The island beyond the edge, which takes back the cells when the island shrinks.
    const outsideA = edge.inside === 'low' ? a0 : a0 - 1
    const outside = outsideA >= 0 && outsideA < across.length - 1 ? grid.owner[at(outsideA, b)] : -1
    for (let a = Math.min(a0, a1); a < Math.max(a0, a1); a++) {
      const index = at(a, b)
      if (outward) grid.owner[index] = k
      else if (grid.owner[index] === k) grid.owner[index] = outside
    }
  }
  const rebuilt = plain.map((island, idx) => ({ ...island, rects: cellsToRects(grid, (index) => grid.owner[index] === idx) }))
  if (rebuilt[k].rects.length === 0) return islands
  const byNet = new Map(rebuilt.map((island) => [island.net, island]))
  return islands.flatMap((island) => {
    if (island.plane) return [island]
    const updated = byNet.get(island.net)!
    // An island fully taken over by its neighbour has no copper left and is dropped.
    return updated.rects.length > 0 ? [updated] : []
  })
}
