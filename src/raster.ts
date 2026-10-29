import { isRealNet } from './netlist'
import type { CutBoard, CutLine, Island, Point, Rect } from './types'

const EPS = 1e-6

/**
 * The plane cut into cells along every x and y coordinate that matters (rectangle edges, cut
 * lines), so any shape built from them is a set of whole cells. `owner` holds an index per cell,
 * or -1 for no copper.
 */
interface Grid {
  xs: number[]
  ys: number[]
  owner: Int32Array
}

type Axis = 'x' | 'y'

const uniqueSorted = (values: number[]) =>
  [...values].sort((a, b) => a - b).filter((v, k, all) => k === 0 || v - all[k - 1] > EPS)

const indexOf = (values: number[], v: number) => values.findIndex((u) => Math.abs(u - v) < EPS)

const columns = (grid: Grid) => grid.xs.length - 1
const rows = (grid: Grid) => grid.ys.length - 1
const cell = (grid: Grid, i: number, j: number) => j * columns(grid) + i

/**
 * Index helpers for code that works across or along a line: for a vertical line (axis 'x') the
 * cross direction is x and the along direction is y; for a horizontal line it is the other way.
 */
function oriented(grid: Grid, axis: Axis) {
  return {
    across: axis === 'x' ? grid.xs : grid.ys,
    along: axis === 'x' ? grid.ys : grid.xs,
    cell: (a: number, b: number) => (axis === 'x' ? cell(grid, a, b) : cell(grid, b, a)),
  }
}

/** The cells for which `isCell` holds, as few rectangles: runs per row, stacked where they line up. */
function cellsToRects(grid: Grid, isCell: (index: number) => boolean): Rect[] {
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

// ---------- Knife with cut lines: a solid board, split by cuts ----------

/** The copper areas a set of cut lines splits the board into, each as rectangles. */
export function cutRegions({ board, cuts }: CutBoard): Rect[][] {
  const clampX = (v: number) => Math.min(Math.max(v, board.x), board.x + board.w)
  const clampY = (v: number) => Math.min(Math.max(v, board.y), board.y + board.h)
  const grid: Grid = {
    xs: uniqueSorted([board.x, board.x + board.w, ...cuts.flatMap((c) => [clampX(c.x1), clampX(c.x2)])]),
    ys: uniqueSorted([board.y, board.y + board.h, ...cuts.flatMap((c) => [clampY(c.y1), clampY(c.y2)])]),
    owner: new Int32Array(0),
  }
  const count = columns(grid) * rows(grid)

  // blocked[axis][cell] marks the cell's far edge (right for 'x', bottom for 'y') as cut.
  const blocked = { x: new Uint8Array(count), y: new Uint8Array(count) }
  for (const c of cuts) {
    const axis: Axis = Math.abs(c.x1 - c.x2) < EPS ? 'x' : 'y'
    const { across, along, cell: at } = oriented(grid, axis)
    const a = indexOf(across, axis === 'x' ? c.x1 : c.y1)
    if (a <= 0 || a >= across.length - 1) continue // on or outside the board edge
    const [from, to] = axis === 'x' ? [Math.min(c.y1, c.y2), Math.max(c.y1, c.y2)] : [Math.min(c.x1, c.x2), Math.max(c.x1, c.x2)]
    for (let b = 0; b < along.length - 1; b++) {
      if (along[b] >= from - EPS && along[b + 1] <= to + EPS) blocked[axis][at(a - 1, b)] = 1
    }
  }

  const region = new Int32Array(count).fill(-1)
  let regionCount = 0
  for (let start = 0; start < count; start++) {
    if (region[start] !== -1) continue
    region[start] = regionCount
    const queue = [start]
    while (queue.length > 0) {
      const index = queue.pop()!
      const i = index % columns(grid)
      const j = Math.floor(index / columns(grid))
      const neighbours: [number, boolean][] = [
        [index + 1, i + 1 < columns(grid) && !blocked.x[index]],
        [index - 1, i > 0 && !blocked.x[index - 1]],
        [index + columns(grid), j + 1 < rows(grid) && !blocked.y[index]],
        [index - columns(grid), j > 0 && !blocked.y[index - columns(grid)]],
      ]
      for (const [next, open] of neighbours) {
        if (open && region[next] === -1) {
          region[next] = regionCount
          queue.push(next)
        }
      }
    }
    regionCount++
  }

  return Array.from({ length: regionCount }, (_, r) => cellsToRects(grid, (index) => region[index] === r))
}

const containsPoint = (r: Rect, p: Point) =>
  p.x >= r.x - EPS && p.x <= r.x + r.w + EPS && p.y >= r.y - EPS && p.y <= r.y + r.h + EPS

/**
 * Each region belongs to the nets of the lead ends inside it. A region reached by two nets gives
 * both nets the same copper, which the overlap check reports; a region no lead reaches is free copper.
 */
export function islandsFromCuts(knife: CutBoard, leadEnds: { net: string; end: Point }[]): { islands: Island[]; free: Rect[][] } {
  const rectsByNet = new Map<string, Rect[]>()
  const free: Rect[][] = []
  for (const rects of cutRegions(knife)) {
    const nets = new Set(leadEnds.filter((l) => isRealNet(l.net) && rects.some((r) => containsPoint(r, l.end))).map((l) => l.net))
    if (nets.size === 0) free.push(rects)
    for (const net of nets) rectsByNet.set(net, [...(rectsByNet.get(net) ?? []), ...rects])
  }
  return { islands: [...rectsByNet].map(([net, rects]) => ({ net, rects })), free }
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
 * Moves one edge of an island's outline to `target`. Growing takes the cells from whatever lies
 * there; shrinking hands them to the island across the edge, so no gap opens between nets.
 * Returns the islands unchanged when the island would disappear.
 */
export function moveIslandEdge(islands: Island[], net: string, edge: IslandEdge, target: number): Island[] {
  const plain = islands.filter((island) => !island.plane)
  const k = plain.findIndex((island) => island.net === net)
  if (k === -1) return islands
  const grid = rasterize(plain, edge.axis === 'x' ? [edge.at, target] : [], edge.axis === 'y' ? [edge.at, target] : [])
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

/**
 * Cut lines along every boundary between two islands, or between an island and bare board,
 * inside the islands' bounds: cutting them out of a solid board gives the same islands back.
 */
export function cutsFromIslands(islands: Island[]): CutLine[] {
  const grid = rasterize(islands.filter((island) => !island.plane), [], [])
  return (['x', 'y'] as const).flatMap((axis) => {
    const { across, along, cell: at } = oriented(grid, axis)
    const runs: { at: number; from: number; to: number }[] = []
    for (let a = 1; a < across.length - 1; a++) {
      let run: (typeof runs)[number] | undefined
      for (let b = 0; b < along.length - 1; b++) {
        if (grid.owner[at(a - 1, b)] === grid.owner[at(a, b)]) {
          run = undefined
        } else if (run && Math.abs(run.to - along[b]) < EPS) {
          run.to = along[b + 1]
        } else {
          run = { at: across[a], from: along[b], to: along[b + 1] }
          runs.push(run)
        }
      }
    }
    return runs.map((r) => (axis === 'x' ? { x1: r.at, y1: r.from, x2: r.at, y2: r.to } : { x1: r.from, y1: r.at, x2: r.to, y2: r.at }))
  })
}
