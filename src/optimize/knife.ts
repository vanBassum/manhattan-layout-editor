import { snapToGrid, withoutFloatNoise } from '../model/geometry'
import { naturalCompare, pinsByNet } from '../model/netlist'
import type { BuiltNetlist, Island, Netlist, Settings } from '../model/types'
import { componentNets, placeOnIslands, type PlacedPart } from './common'

/** Generous strips: room for parts, their clearance and a soldering iron. */
const ROW_HEIGHT = 14
const RAIL_HEIGHT = 9
const MIN_CELL_WIDTH = 12
const WIDTH_PER_PIN = 6
/** Nets with at least this many pins become full-width rails. */
const RAIL_MIN_PINS = 5
const MAX_RAILS = 3
const MIN_BOARD_WIDTH = 30
/** The board width is rounded up to whole multiples of this. */
const BOARD_WIDTH_STEP = 5
/** In the net chain, sharing parts with the net just before counts this much more than with earlier ones. */
const LAST_NET_WEIGHT = 3

/**
 * Knife: unlike Manhattan, the copper comes first, because straight edge-to-edge cuts
 * only work when the nets are laid out for them. Full-width horizontal cuts separate rows; each
 * row is split by short vertical cuts running from one horizontal cut to the next. The busiest
 * nets become full-width rails, and nets that share parts are neighbors. Components are then
 * placed onto the strips with the shared collision-free placer.
 */
function knifeLayout(netlist: BuiltNetlist, settings: Settings) {
  const pinsOnNet = pinsByNet(netlist)
  const pins = (net: string) => pinsOnNet.get(net)?.length ?? 1

  // Busy nets (supply, ground) become full-width rails, but at their place in the chain rather than
  // at the board edges, so rails joined by e.g. decoupling capacitors end up next to each other.
  const busiest = [...netlist.nets].sort((a, b) => pins(b) - pins(a) || naturalCompare(a, b))
  const rails = new Set(busiest.filter((net) => pins(net) >= RAIL_MIN_PINS).slice(0, MAX_RAILS))
  const chain = chainNets(netlist, busiest)

  const cellWidth = (net: string) => Math.max(MIN_CELL_WIDTH, pins(net) * WIDTH_PER_PIN)
  const cells = chain.filter((net) => !rails.has(net))
  const area = cells.reduce((sum, net) => sum + cellWidth(net) * ROW_HEIGHT, 0)
  const boardWidth = Math.ceil(Math.max(...cells.map(cellWidth), Math.sqrt(area), MIN_BOARD_WIDTH) / BOARD_WIDTH_STEP) * BOARD_WIDTH_STEP

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
    let unstretchedRight = 0
    let x = 0
    ordered.forEach((net, k) => {
      unstretchedRight += cellWidth(net)
      const right = k === ordered.length - 1 ? boardWidth : snapToGrid((unstretchedRight / rowWidth) * boardWidth, settings.snap)
      islands.push({ net, rects: [{ x, y, w: withoutFloatNoise(right - x), h: ROW_HEIGHT }] })
      x = right
    })
    y += ROW_HEIGHT
  }

  return { islands, placements: placeOnIslands(netlist, islands, settings) }
}

/** Orders nets so that each next net shares the most parts with the ones just before it. */
function chainNets(netlist: Netlist, nets: string[]): string[] {
  const shared = (a: string, b: string) =>
    netlist.components.filter((c) => {
      const cn = componentNets(c)
      return cn.includes(a) && cn.includes(b)
    }).length
  const remaining = [...nets].sort(naturalCompare)
  const chain: string[] = []
  while (remaining.length > 0) {
    const score = (net: string) => chain.reduce((sum, p, k) => sum + shared(net, p) * (k === chain.length - 1 ? LAST_NET_WEIGHT : 1), 0)
    let best = 0
    for (let k = 1; k < remaining.length; k++) if (score(remaining[k]) > score(remaining[best])) best = k
    const [next] = remaining.splice(best, 1)
    chain.push(next)
  }
  return chain
}

// Temporary: still lays out its own strips and places the parts on them, ignoring `parts`.
export const knifeCopper = (netlist: BuiltNetlist, _parts: PlacedPart[], settings: Settings) => knifeLayout(netlist, settings)
