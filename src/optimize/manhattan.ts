import { boundsOf, inflate, rectContains, rectsOverlap, snapToGrid } from '../geometry'
import { onCopper, solderPoint, toLocal, toWorld } from '../layout'
import { isRealNet, naturalCompare } from '../netlist'
import type { Island, Netlist, Point, Rect, Settings } from '../types'
import type { Strategy } from './index'
import { leadCost, leadLimit, netPinCounts, placeComponents, spiralOffsets, type PlacedPart } from './common'

const GROUND_NAMES = /^(GND|AGND|DGND|PGND|VSS|0V|EARTH|GROUND)$/i
/** Standard square pad sizes (mm) and how many leads each takes with room to solder and probe. */
const PAD_SIZES: [side: number, leads: number][] = [
  [4, 2],
  [5, 3],
  [6, 4],
  [7, 6],
]
const LONG_PAD_WIDTH = 7
const LEAD_SPACING = 3.5
/** Bare ground plane between neighboring pads. */
const PAD_SPACING = 1.5
/** Foreign lead ends must stay this far from a pad's edge, or they would touch it. */
const FOREIGN_LEAD_CLEARANCE = 0.8

/** SMD parts are made to straddle an edge: their other end may sit right next to the pad. */
const foreignClearance = (lead: Lead) => (lead.part.geometry.shape === 'smd' ? 0.05 : FOREIGN_LEAD_CLEARANCE)
const PAD_SEARCH_RADIUS = 15
const PAD_SEARCH_STEP = 0.5
const PLANE_MARGIN = 5

interface Lead {
  part: PlacedPart
  index: number
  net: string
  anchor: Point
  end: Point
  limit: number
}

function padSize(leadCount: number): { w: number; h: number } {
  const standard = PAD_SIZES.find(([, leads]) => leadCount <= leads)
  if (standard) return { w: standard[0], h: standard[0] }
  return { w: LONG_PAD_WIDTH, h: Math.ceil(leadCount / 2) * LEAD_SPACING }
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Glued-pad Manhattan: the copper-clad board is the ground net, every other net gets exactly one
 * standard pad glued on top, shared by all its leads. Components are placed first; each pad then
 * goes where its leads reach it most easily without touching other leads or pads, and leads are
 * bent onto their pad. Ground leads solder straight to the board.
 */
function manhattanLayout(netlist: Netlist, settings: Settings) {
  const pinCounts = netPinCounts(netlist)
  const busiest = [...netlist.nets].sort((a, b) => (pinCounts.get(b) ?? 0) - (pinCounts.get(a) ?? 0))[0]
  const ground = netlist.nets.find((net) => GROUND_NAMES.test(net)) ?? busiest

  const parts = placeComponents(netlist, settings)
  const leads: Lead[] = parts.flatMap((part) =>
    part.component.pins.flatMap((pin, index) =>
      isRealNet(pin.net)
        ? [{ part, index, net: pin.net, anchor: toWorld(part.geometry.anchors[index], part.placement), end: part.ends[index], limit: leadLimit(part.geometry, settings) }]
        : [],
    ),
  )

  const padNets = netlist.nets
    .filter((net) => net !== ground)
    .sort((a, b) => (pinCounts.get(b) ?? 0) - (pinCounts.get(a) ?? 0) || naturalCompare(a, b))
  const pads: Island[] = []
  for (const net of padNets) {
    const own = leads.filter((l) => l.net === net)
    const foreign = leads.filter((l) => l.net !== net)
    const size = padSize(own.length)
    // On the search grid, so the pad edges (whole millimeters apart) land on it too.
    const center = {
      x: snapToGrid(median(own.map((l) => l.end.x)), PAD_SEARCH_STEP),
      y: snapToGrid(median(own.map((l) => l.end.y)), PAD_SEARCH_STEP),
    }

    let best: { rect: Rect; cost: number } | null = null
    for (const offset of spiralOffsets(PAD_SEARCH_RADIUS, PAD_SEARCH_STEP)) {
      const rect = { x: center.x + offset.x - size.w / 2, y: center.y + offset.y - size.h / 2, w: size.w, h: size.h }
      if (pads.some((p) => rectsOverlap(inflate(p.rects[0], PAD_SPACING), rect))) continue
      if (foreign.some((l) => rectContains(inflate(rect, foreignClearance(l)), l.end))) continue
      const pad = { net, rects: [rect] }
      const cost =
        own.reduce((sum, l) => {
          const target = solderPoint(pad, l.anchor, l.part.geometry, settings.isolation)
          return sum + leadCost(Math.hypot(target.x - l.anchor.x, target.y - l.anchor.y), l.limit)
        }, 0) +
        0.1 * Math.hypot(offset.x, offset.y)
      if (!best || cost < best.cost) best = { rect, cost }
    }
    pads.push({ net, rects: [best?.rect ?? { x: center.x - size.w / 2, y: center.y - size.h / 2, ...size }] })
  }

  const placements = parts.map((part) => {
    const bent: Record<string, Point> = {}
    for (const lead of leads.filter((l) => l.part === part)) {
      const end = lead.net === ground ? groundEnd(lead, pads) : padEnd(lead, pads, settings.isolation)
      if (end) bent[part.component.pins[lead.index].number] = toLocal(end, part.placement)
    }
    return Object.keys(bent).length > 0 ? { ...part.placement, leads: bent } : part.placement
  })

  const everything = [...parts.map((p) => p.keepOut), ...pads.map((p) => p.rects[0])]
  const plane: Island = { net: ground, plane: true, rects: [gridOutward(inflate(boundsOf(everything)!, PLANE_MARGIN), PAD_SEARCH_STEP)] }
  return { islands: [plane, ...pads], placements }
}

/** The smallest rectangle with edges on the grid that contains `r`. */
function gridOutward(r: Rect, step: number): Rect {
  const left = Math.floor(r.x / step) * step
  const top = Math.floor(r.y / step) * step
  const right = Math.ceil((r.x + r.w) / step) * step
  const bottom = Math.ceil((r.y + r.h) / step) * step
  return { x: snapToGrid(left, 0), y: snapToGrid(top, 0), w: snapToGrid(right - left, 0), h: snapToGrid(bottom - top, 0) }
}

/** Bends a lead onto its pad, or returns null when it already lands there. */
function padEnd(lead: Lead, pads: Island[], isolation: number): Point | null {
  const pad = pads.find((p) => p.net === lead.net)
  if (!pad || onCopper(pad, lead.end, isolation)) return null
  return solderPoint(pad, lead.anchor, lead.part.geometry, isolation)
}

/** A ground lead that would land on a pad is extended straight on until it reaches bare plane. */
function groundEnd(lead: Lead, pads: Island[]): Point | null {
  const onPad = (p: Point) => pads.some((pad) => rectContains(inflate(pad.rects[0], foreignClearance(lead)), p))
  if (!onPad(lead.end)) return null
  const dx = lead.end.x - lead.anchor.x
  const dy = lead.end.y - lead.anchor.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return null
  for (let reach = length; reach <= lead.limit; reach += 0.5) {
    const p = { x: lead.anchor.x + (dx / length) * reach, y: lead.anchor.y + (dy / length) * reach }
    if (!onPad(p)) return p
  }
  return null
}

export const manhattanStrategy: Strategy = {
  id: 'manhattan',
  label: 'Manhattan (glued pads)',
  description: 'Parts first, then one standard pad per net glued onto the board; the board itself is ground',
  run: manhattanLayout,
}
