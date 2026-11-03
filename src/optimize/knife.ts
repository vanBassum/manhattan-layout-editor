import { boundsOf, inflate, snapToGrid } from '../model/geometry'
import { cellsToRects, columns, rows, uniqueSorted, type Grid } from '../model/raster'
import type { BuiltNetlist, Layout, Point, Settings } from '../model/types'
import { bendOnto, gridOutward, leadsOf, withBentLeads, type Lead, type PlacedPart } from './common'

/** Lead ends closer together than this on an axis share a column (or row) of cells. */
const MIN_CELL = 1
/** Copper beyond the outermost parts. */
const BOARD_MARGIN = 3
/** Cut lines and the board edge lie on this grid. */
const CUT_GRID = 0.5
const FREE = -1

/**
 * Knife: the copper board is cut into one island per net. The board is divided into cells by lines
 * halfway between the lead ends, so cuts run straight between them and every lead end lies inside
 * its cell with room to spare. Each lead end claims its cell for its net. Then each net's cells are
 * joined by the shortest way through free cells, nets with close-together leads first, so the
 * far-reaching ones (supply rails) go around them. Last, every free cell goes to the nearest net,
 * so the islands cover the board and the cuts are their shared edges. A lead end that could not be
 * joined to its net, or shares its cell with another net's, is bent onto its net's island.
 */
export function knifeCopper(netlist: BuiltNetlist, parts: PlacedPart[], settings: Settings): Layout {
  const leads = leadsOf(parts, settings)
  const board = gridOutward(inflate(boundsOf(parts.map((p) => p.keepOut))!, BOARD_MARGIN), CUT_GRID)
  const xs = cellLines(leads.map((l) => l.end.x), board.x, board.x + board.w)
  const ys = cellLines(leads.map((l) => l.end.y), board.y, board.y + board.h)
  const grid: Grid = { xs, ys, owner: new Int32Array((xs.length - 1) * (ys.length - 1)).fill(FREE) }

  const nets = netlist.nets.filter((net) => leads.some((l) => l.net === net))
  for (const lead of leads) {
    const cell = cellAt(grid, lead.end)
    if (grid.owner[cell] === FREE) grid.owner[cell] = nets.indexOf(lead.net)
  }
  const bySpan = nets.map((_, k) => k).sort((a, b) => span(leads, nets[a]) - span(leads, nets[b]))
  for (const net of bySpan) joinNet(grid, net)
  growIntoFreeCells(grid)

  const islands = nets.map((net, k) => ({ net, rects: cellsToRects(grid, (cell) => grid.owner[cell] === k) }))
  const islandOf = new Map(islands.map((island) => [island.net, island]))
  const placements = withBentLeads(parts, leads, (lead) => bendOnto(islandOf.get(lead.net)!, lead, settings.isolation))
  return { islands, placements }
}

/** Lines from `from` to `to`, and on the cut grid halfway between values that lie at least MIN_CELL apart. */
function cellLines(values: number[], from: number, to: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const between = sorted.flatMap((v, k) => (k > 0 && v - sorted[k - 1] >= MIN_CELL ? [snapToGrid((v + sorted[k - 1]) / 2, CUT_GRID)] : []))
  return uniqueSorted([from, ...between, to])
}

function cellAt(grid: Grid, p: Point): number {
  return band(grid.ys, p.y) * columns(grid) + band(grid.xs, p.x)
}

/** Which of the bands between `lines` holds `v`. */
function band(lines: number[], v: number): number {
  let k = 0
  while (k < lines.length - 2 && lines[k + 1] <= v) k++
  return k
}

/** The cells for which `holds` is true. */
const cellsWhere = (grid: Grid, holds: (owner: number, cell: number) => boolean) =>
  Array.from(grid.owner).flatMap((owner, cell) => (holds(owner, cell) ? [cell] : []))

/** Half the perimeter around a net's lead ends: how far the net reaches. */
function span(leads: Lead[], net: string): number {
  const bounds = boundsOf(leads.filter((l) => l.net === net).map((l) => ({ ...l.end, w: 0, h: 0 })))!
  return bounds.w + bounds.h
}

function centre(grid: Grid, cell: number): Point {
  const i = cell % columns(grid)
  const j = Math.floor(cell / columns(grid))
  return { x: (grid.xs[i] + grid.xs[i + 1]) / 2, y: (grid.ys[j] + grid.ys[j + 1]) / 2 }
}

function neighbours(grid: Grid, cell: number): number[] {
  const i = cell % columns(grid)
  const j = Math.floor(cell / columns(grid))
  const result: number[] = []
  if (i > 0) result.push(cell - 1)
  if (i < columns(grid) - 1) result.push(cell + 1)
  if (j > 0) result.push(cell - columns(grid))
  if (j < rows(grid) - 1) result.push(cell + columns(grid))
  return result
}

const distance = (grid: Grid, a: number, b: number) => {
  const p = centre(grid, a)
  const q = centre(grid, b)
  return Math.hypot(p.x - q.x, p.y - q.y)
}

/** The cells of `net` connected to `start`, edge to edge. */
function connectedCells(grid: Grid, start: number, net: number): Set<number> {
  const found = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    for (const next of neighbours(grid, queue.pop()!)) {
      if (grid.owner[next] === net && !found.has(next)) {
        found.add(next)
        queue.push(next)
      }
    }
  }
  return found
}

/**
 * Joins the cells of `net` one at a time by the shortest way through free cells. Cells that cannot
 * be reached are given up: their lead ends are bent onto the island later.
 */
function joinNet(grid: Grid, net: number) {
  const start = grid.owner.indexOf(net)
  for (;;) {
    const joined = connectedCells(grid, start, net)
    const apart = new Set(cellsWhere(grid, (owner, cell) => owner === net && !joined.has(cell)))
    if (apart.size === 0) return
    const path = shortestPath(grid, joined, apart)
    if (!path) {
      for (const cell of apart) grid.owner[cell] = FREE
      return
    }
    for (const cell of path) grid.owner[cell] = net
  }
}

/** The free cells on the shortest way from `from` to any cell of `to`, or null when there is none. */
function shortestPath(grid: Grid, from: Set<number>, to: Set<number>): number[] | null {
  const previous = new Int32Array(grid.owner.length).fill(-1)
  const reached = nearestFirst(grid, [...from], (cell) => grid.owner[cell] === FREE || to.has(cell), (cell, from) => {
    previous[cell] = from
    return to.has(cell)
  })
  if (reached === null) return null
  const path: number[] = []
  for (let cell = previous[reached]; !from.has(cell); cell = previous[cell]) path.push(cell)
  return path
}

/** Every free cell goes to the net whose copper is nearest, growing outward from all nets at once. */
function growIntoFreeCells(grid: Grid) {
  nearestFirst(grid, cellsWhere(grid, (owner) => owner !== FREE), (cell) => grid.owner[cell] === FREE, (cell, from) => {
    grid.owner[cell] = grid.owner[from]
    return false
  })
}

/**
 * Visits the cells that `mayEnter` allows in order of distance from `sources` (Dijkstra between cell
 * centres), telling `visit` each cell and the cell it was reached from. Stops at the first cell for
 * which `visit` returns true and returns it; null when every reachable cell was visited.
 */
function nearestFirst(
  grid: Grid,
  sources: number[],
  mayEnter: (cell: number) => boolean,
  visit: (cell: number, from: number) => boolean,
): number | null {
  const cost = new Float64Array(grid.owner.length).fill(Infinity)
  const cameFrom = new Int32Array(grid.owner.length).fill(-1)
  const done = new Uint8Array(grid.owner.length)
  const waiting = new Set<number>()
  for (const cell of sources) {
    cost[cell] = 0
    waiting.add(cell)
  }
  while (waiting.size > 0) {
    let cell = -1
    for (const c of waiting) if (cell === -1 || cost[c] < cost[cell]) cell = c
    waiting.delete(cell)
    done[cell] = 1
    if (cameFrom[cell] !== -1 && visit(cell, cameFrom[cell])) return cell
    for (const next of neighbours(grid, cell)) {
      if (done[next] || !mayEnter(next)) continue
      const through = cost[cell] + distance(grid, cell, next)
      if (through < cost[next]) {
        cost[next] = through
        cameFrom[next] = cell
        waiting.add(next)
      }
    }
  }
  return null
}
