import { snapToGrid } from '../geometry'
import { naturalCompare } from '../netlist'
import type { Island, Netlist, Settings } from '../types'
import type { Strategy } from './index'
import { componentNets, netPinCounts, placeOnIslands } from './common'

/** Generous strips: room for parts, their clearance and a soldering iron. */
const ROW_HEIGHT = 14
const RAIL_HEIGHT = 9
const MIN_CELL_WIDTH = 12
const WIDTH_PER_PIN = 6
/** Nets with at least this many pins become full-width rails. */
const RAIL_MIN_PINS = 5
const MAX_RAILS = 3

/**
 * Knife: unlike Manhattan, the copper comes first, because straight edge-to-edge cuts
 * only work when the nets are laid out for them. Full-width horizontal cuts separate rows; each
 * row is split by short vertical cuts running from one horizontal cut to the next. The busiest
 * nets become full-width rails, and nets that share parts are neighbors. Components are then
 * placed onto the strips with the shared collision-free placer.
 */
function knifeLayout(netlist: Netlist, settings: Settings) {
  const pinCounts = netPinCounts(netlist)
  const pins = (net: string) => pinCounts.get(net) ?? 1

  // Busy nets (supply, ground) become full-width rails, but at their place in the chain rather than
  // at the board edges, so rails joined by e.g. decoupling capacitors end up next to each other.
  const busiest = [...netlist.nets].sort((a, b) => pins(b) - pins(a) || naturalCompare(a, b))
  const rails = new Set(busiest.filter((net) => pins(net) >= RAIL_MIN_PINS).slice(0, MAX_RAILS))
  const chain = chainNets(netlist, busiest, [])

  const cellWidth = (net: string) => Math.max(MIN_CELL_WIDTH, pins(net) * WIDTH_PER_PIN)
  const cells = chain.filter((net) => !rails.has(net))
  const area = cells.reduce((sum, net) => sum + cellWidth(net) * ROW_HEIGHT, 0)
  const boardWidth = Math.ceil(Math.max(...cells.map(cellWidth), Math.sqrt(area), 30) / 5) * 5

  const rows: { rail: boolean; nets: string[] }[] = []
  let used = 0
  for (const net of chain) {
    const current = rows[rows.length - 1]
    if (rails.has(net)) {
      rows.push({ rail: true, nets: [net] })
    } else if (!current || current.rail || used + cellWidth(net) > boardWidth) {
      rows.push({ rail: false, nets: [net] })
      used = cellWidth(net)
    } else {
      current.nets.push(net)
      used += cellWidth(net)
    }
  }

  const islands: Island[] = []
  let y = 0
  let cellRowIndex = 0
  for (const row of rows) {
    if (row.rail) {
      islands.push({ net: row.nets[0], rects: [{ x: 0, y, w: boardWidth, h: RAIL_HEIGHT }] })
      y += RAIL_HEIGHT
      continue
    }
    // Every other row runs right to left, so the chain continues straight down at the row ends.
    const ordered = cellRowIndex++ % 2 === 0 ? row.nets : [...row.nets].reverse()
    // Stretch the cells so each row runs edge to edge and every vertical cut ends on a horizontal one.
    // Neighboring cells touch: the cut runs along their shared edge, which lies on the snap grid.
    const rowWidth = ordered.reduce((sum, net) => sum + cellWidth(net), 0)
    let used = 0
    let x = 0
    ordered.forEach((net, k) => {
      used += cellWidth(net)
      const right = k === ordered.length - 1 ? boardWidth : snapToGrid((used / rowWidth) * boardWidth, settings.snap)
      islands.push({ net, rects: [{ x, y, w: snapToGrid(right - x, 0), h: ROW_HEIGHT }] })
      x = right
    })
    y += ROW_HEIGHT
  }

  return { islands, placements: placeOnIslands(netlist, islands, settings) }
}

/**
 * Orders nets so that each next net shares the most parts with the ones just before it.
 * `context` nets count as already placed but are not part of the result.
 */
function chainNets(netlist: Netlist, nets: string[], context: string[]): string[] {
  const shared = (a: string, b: string) =>
    netlist.components.filter((c) => {
      const cn = componentNets(c)
      return cn.includes(a) && cn.includes(b)
    }).length
  const remaining = [...nets].sort(naturalCompare)
  const chain = [...context]
  const result: string[] = []
  while (remaining.length > 0) {
    const score = (net: string) => chain.reduce((sum, p, k) => sum + shared(net, p) * (k === chain.length - 1 ? 3 : 1), 0)
    let best = 0
    for (let k = 1; k < remaining.length; k++) if (score(remaining[k]) > score(remaining[best])) best = k
    const [next] = remaining.splice(best, 1)
    chain.push(next)
    result.push(next)
  }
  return result
}

export const knifeStrategy: Strategy = {
  id: 'knife',
  label: 'Knife – polygons',
  description: 'Rectangular strips with straight edge-to-edge cuts, parts placed collision-free on top',
  run: knifeLayout,
}
