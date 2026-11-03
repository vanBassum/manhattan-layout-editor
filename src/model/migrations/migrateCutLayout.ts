// Until November 2026 a layout could be a solid board split by cut lines ("Knife – cut lines"),
// with the islands following from the cuts and from where the leads end. That mode is gone:
// such a layout becomes the islands its cuts gave, which every editing mode can work on.
// Everything that only such layouts need lives here, so dropping the migration is one file.

import { buildNetlist } from '../definitions'
import { defaultLeadEnds, toWorld } from '../layout'
import { isRealNet } from '../netlist'
import { cellsToRects, columns, indexOf, oriented, rows, uniqueSorted, type Axis, type Grid } from '../raster'
import type { Island, Layout, Point, Project, Rect, Settings } from '../types'

const CUT_LINES_STRATEGY = 'knife-cuts'
const EPS = 1e-6

/** A straight cut along x or y (x1 = x2 or y1 = y2). */
interface CutLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** A solid board split by cuts. Which net each piece belongs to follows from the leads. */
interface CutBoard {
  board: Rect
  cuts: CutLine[]
}

type CutLineLayout = Layout & { knife?: CutBoard; freeCopper?: unknown }

export function withoutCutLines(project: Project): Project {
  const { knife, freeCopper: _derived, ...layout } = project.layout as CutLineLayout
  // Settings come straight from the stored project here: they may still hold the strategy files had
  // before v8, which projectFormat turns into a build style afterwards.
  const stored = project.settings as Settings & { strategy?: string }
  const settings = stored.strategy === CUT_LINES_STRATEGY ? { ...stored, strategy: 'knife' } : project.settings
  if (!knife) return { ...project, settings }

  const netlist = buildNetlist(project.netlist, layout.placements, project.definitions)
  const components = new Map(netlist.components.map((c) => [c.ref, c]))
  const leadEnds = layout.placements.flatMap((placement) => {
    const component = components.get(placement.ref)
    if (!component) return []
    const defaults = defaultLeadEnds(component.geometry)
    return component.pins.map((pin, k) => ({ net: pin.net, end: toWorld(placement.leads?.[pin.number] ?? defaults[k], placement) }))
  })
  return { ...project, settings, layout: { ...layout, islands: islandsFromCuts(knife, leadEnds) } }
}

/** The copper areas a set of cut lines splits the board into, each as rectangles. */
function cutRegions({ board, cuts }: CutBoard): Rect[][] {
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
 * both nets the same copper, which the overlap check reports; a region no lead reaches had no net
 * and is left out.
 */
function islandsFromCuts(knife: CutBoard, leadEnds: { net: string; end: Point }[]): Island[] {
  const rectsByNet = new Map<string, Rect[]>()
  for (const rects of cutRegions(knife)) {
    const nets = new Set(leadEnds.filter((l) => isRealNet(l.net) && rects.some((r) => containsPoint(r, l.end))).map((l) => l.net))
    for (const net of nets) rectsByNet.set(net, [...(rectsByNet.get(net) ?? []), ...rects])
  }
  return [...rectsByNet].map(([net, rects]) => ({ net, rects }))
}
