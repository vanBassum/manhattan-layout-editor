import type { Island, Netlist, Point, Rect, Settings } from '../types'
import type { Strategy } from './index'
import { boardBounds, endsByNet, placeComponents } from './common'

const CELL = 0.5
/** Copper grown around every lead end before anything else, in cells: room for solder and a probe. */
const PAD_RADIUS = 3
/** Width of connecting copper, in cells, when there is room for it. */
const WIDE_TRACK = 3
const BOARD_MARGIN = 4
const EMPTY = -1

/**
 * Laser: components first, then copper. Every lead end gets a pad, each net's pads are joined by
 * the shortest copper path that keeps clear of other nets, and finally all islands grow outward
 * together until they meet. Islands end up large and freely shaped, separated only by the
 * isolation channels the laser actually has to cut.
 */
function laserLayout(netlist: Netlist, settings: Settings) {
  const parts = placeComponents(netlist, settings)
  const board = boardBounds(parts, BOARD_MARGIN)
  const islands = growIslands(board, endsByNet(parts), settings.isolation)
  return { islands, placements: parts.map((p) => p.placement) }
}

function growIslands(board: Rect, ends: Map<string, Point[]>, isolation: number): Island[] {
  const columns = Math.ceil(board.w / CELL)
  const rows = Math.ceil(board.h / CELL)
  const owner = new Int32Array(columns * rows).fill(EMPTY)
  const gap = Math.max(1, Math.ceil(isolation / CELL))
  const nets = [...ends.keys()]
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < columns && j < rows
  const at = (i: number, j: number) => j * columns + i

  /** A cell may join net n if no other net's copper lies within the isolation gap. */
  const canTake = (i: number, j: number, n: number) => {
    if (!inside(i, j)) return false
    for (let dj = -gap; dj <= gap; dj++) {
      for (let di = -gap; di <= gap; di++) {
        if (!inside(i + di, j + dj)) continue
        const o = owner[at(i + di, j + dj)]
        if (o !== EMPTY && o !== n) return false
      }
    }
    return true
  }
  const hasNeighbor = (i: number, j: number, n: number) =>
    [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => inside(i + di, j + dj) && owner[at(i + di, j + dj)] === n)

  // Lead ends must be on copper, whatever else happens.
  const seeds = nets.map((net) =>
    ends.get(net)!.map((p) => ({
      i: Math.min(columns - 1, Math.max(0, Math.floor((p.x - board.x) / CELL))),
      j: Math.min(rows - 1, Math.max(0, Math.floor((p.y - board.y) / CELL))),
    })),
  )
  seeds.forEach((cells, n) => cells.forEach((c) => (owner[at(c.i, c.j)] = n)))

  // Pads, one ring at a time for all lead ends, so neighbors share the space fairly.
  for (let r = 1; r <= PAD_RADIUS; r++) {
    seeds.forEach((cells, n) => {
      for (const c of cells) {
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
            const i = c.i + di
            const j = c.j + dj
            if (canTake(i, j, n) && owner[at(i, j)] === EMPTY && hasNeighbor(i, j, n)) owner[at(i, j)] = n
          }
        }
      }
    })
  }

  // Join each net's pads, shortest nets first so they don't get walled in by long ones.
  const span = (n: number) => {
    const xs = seeds[n].map((c) => c.i)
    const ys = seeds[n].map((c) => c.j)
    return Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)
  }
  const byShortestSpan = nets.map((_, n) => n).sort((a, b) => span(a) - span(b))
  for (const n of byShortestSpan) {
    while (joinOnePiece(n, seeds[n][0], WIDE_TRACK) || joinOnePiece(n, seeds[n][0], 1)) {
      // Keep joining until the net is one piece or no path exists (it then shows as split).
    }
  }

  // Grow all islands outward together into the remaining space.
  let frontier: number[] = []
  owner.forEach((o, k) => o !== EMPTY && frontier.push(k))
  while (frontier.length > 0) {
    const next: number[] = []
    for (const k of frontier) {
      const n = owner[k]
      const i = k % columns
      const j = Math.floor(k / columns)
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (inside(i + di, j + dj) && owner[at(i + di, j + dj)] === EMPTY && canTake(i + di, j + dj, n)) {
          owner[at(i + di, j + dj)] = n
          next.push(at(i + di, j + dj))
        }
      }
    }
    frontier = next
  }

  return nets.map((net, n) => ({ net, rects: cellsToRects(n) }))

  /**
   * Breadth-first search from the piece containing `start` to any other copper of the same net,
   * through cells the net may take. Returns false when the net is already one piece or no path exists.
   */
  function joinOnePiece(n: number, start: { i: number; j: number }, width: number): boolean {
    const half = Math.floor(width / 2)
    const piece = new Uint8Array(columns * rows)
    const stack = [at(start.i, start.j)]
    piece[stack[0]] = 1
    while (stack.length > 0) {
      const k = stack.pop()!
      const i = k % columns
      const j = Math.floor(k / columns)
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const m = at(i + di, j + dj)
        if (inside(i + di, j + dj) && !piece[m] && owner[m] === n) {
          piece[m] = 1
          stack.push(m)
        }
      }
    }
    const fitsTrack = (i: number, j: number) => {
      for (let dj = -half; dj <= half; dj++) for (let di = -half; di <= half; di++) if (!canTake(i + di, j + dj, n)) return false
      return true
    }

    const previous = new Int32Array(columns * rows).fill(-2)
    let queue: number[] = []
    piece.forEach((inPiece, k) => {
      if (inPiece) {
        previous[k] = -1
        queue.push(k)
      }
    })
    let reached = -1
    while (queue.length > 0 && reached < 0) {
      const next: number[] = []
      for (const k of queue) {
        const i = k % columns
        const j = Math.floor(k / columns)
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const m = at(i + di, j + dj)
          if (!inside(i + di, j + dj) || previous[m] !== -2) continue
          if (owner[m] === n) {
            previous[m] = k
            reached = m
            break
          }
          if (!fitsTrack(i + di, j + dj)) continue
          previous[m] = k
          next.push(m)
        }
        if (reached >= 0) break
      }
      queue = next
    }
    if (reached < 0) return false

    for (let k = previous[reached]; k >= 0 && !piece[k]; k = previous[k]) {
      const i = k % columns
      const j = Math.floor(k / columns)
      for (let dj = -half; dj <= half; dj++) for (let di = -half; di <= half; di++) owner[at(i + di, j + dj)] = n
    }
    return true
  }

  /** Greedy: take the first free cell, extend right as far as possible, then down. */
  function cellsToRects(n: number): Rect[] {
    const used = new Uint8Array(columns * rows)
    const free = (i: number, j: number) => inside(i, j) && owner[at(i, j)] === n && !used[at(i, j)]
    const rects: Rect[] = []
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        if (!free(i, j)) continue
        let w = 1
        while (free(i + w, j)) w++
        let h = 1
        while (Array.from({ length: w }, (_, d) => free(i + d, j + h)).every(Boolean)) h++
        for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) used[at(i + di, j + dj)] = 1
        rects.push({ x: board.x + i * CELL, y: board.y + j * CELL, w: w * CELL, h: h * CELL })
      }
    }
    return rects
  }
}

export const laserStrategy: Strategy = {
  id: 'laser',
  label: 'Laser',
  description: 'Parts first, then free-form islands grown around their leads; the laser cuts any outline',
  run: laserLayout,
}
