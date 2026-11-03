import { boundsOf, inflate, rectContains, rectsOverlap, snapToGrid, withoutFloatNoise } from '../model/geometry'
import { onCopper, solderPoint, toLocal, toWorld } from '../model/layout'
import { isGroundNet, isRealNet, naturalCompare, pinsByNet } from '../model/netlist'
import type { BuiltNetlist, Island, Layout, Point, Rect, Settings } from '../model/types'
import type { FullSchematic } from '../model/schematic'
import type { Strategy } from './strategy'
import { leadCost, leadLimit, spiralOffsets, type PlacedPart } from './common'
import { placeFromSchematic } from './fromSchematic'

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
const SMD_FOREIGN_LEAD_CLEARANCE = 0.05
const PAD_SEARCH_RADIUS = 15
const PAD_SEARCH_STEP = 0.5
/** Small pull of a pad toward the median of its lead ends. */
const PAD_COMPACTNESS = 0.1
/** How far a ground lead is extended at a time while looking for bare plane. */
const GROUND_LEAD_STEP = 0.5
const PLANE_MARGIN = 5

const foreignClearance = (lead: Lead) =>
  lead.part.component.geometry.shape === 'smd' ? SMD_FOREIGN_LEAD_CLEARANCE : FOREIGN_LEAD_CLEARANCE

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
 * standard pad glued on top, shared by all its leads. Components go where the schematic has them;
 * the copper follows them.
 */
function manhattanLayout(netlist: BuiltNetlist, settings: Settings, schematic: FullSchematic): Layout {
  return manhattanCopper(netlist, placeFromSchematic(netlist, settings, schematic), settings)
}

/**
 * The copper for parts that are already placed: each pad goes where its leads reach it most easily
 * without touching other leads or pads, and leads are bent onto their pad. Ground leads solder
 * straight to the board, which reaches a margin beyond every part and pad.
 */
function manhattanCopper(netlist: BuiltNetlist, parts: PlacedPart[], settings: Settings): Layout {
  const pinsOnNet = pinsByNet(netlist)
  const pinCount = (net: string) => pinsOnNet.get(net)?.length ?? 0
  const busiest = [...netlist.nets].sort((a, b) => pinCount(b) - pinCount(a))[0]
  const ground = netlist.nets.find(isGroundNet) ?? busiest

  const leads: Lead[] = parts.flatMap((part) => {
    const { geometry } = part.component
    return part.component.pins.flatMap((pin, index) =>
      isRealNet(pin.net)
        ? [{ part, index, net: pin.net, anchor: toWorld(geometry.anchors[index], part.placement), end: part.ends[index], limit: leadLimit(geometry, settings) }]
        : [],
    )
  })

  const padNets = netlist.nets
    .filter((net) => net !== ground)
    .sort((a, b) => pinCount(b) - pinCount(a) || naturalCompare(a, b))
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
          const target = solderPoint(pad, l.anchor, l.part.component.geometry, settings.isolation)
          return sum + leadCost(Math.hypot(target.x - l.anchor.x, target.y - l.anchor.y), l.limit)
        }, 0) +
        PAD_COMPACTNESS * Math.hypot(offset.x, offset.y)
      if (!best || cost < best.cost) best = { rect, cost }
    }
    if (!best) throw new Error(`No free spot found for the pad of net ${net}`)
    pads.push({ net, rects: [best.rect] })
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
  return { x: withoutFloatNoise(left), y: withoutFloatNoise(top), w: withoutFloatNoise(right - left), h: withoutFloatNoise(bottom - top) }
}

/** Bends a lead onto its pad, or returns null when it already lands there. */
function padEnd(lead: Lead, pads: Island[], isolation: number): Point | null {
  const pad = pads.find((p) => p.net === lead.net)
  if (!pad || onCopper(pad, lead.end, isolation)) return null
  return solderPoint(pad, lead.anchor, lead.part.component.geometry, isolation)
}

/** A ground lead that would land on a pad is extended straight on until it reaches bare plane. */
function groundEnd(lead: Lead, pads: Island[]): Point | null {
  const onPad = (p: Point) => pads.some((pad) => rectContains(inflate(pad.rects[0], foreignClearance(lead)), p))
  if (!onPad(lead.end)) return null
  const dx = lead.end.x - lead.anchor.x
  const dy = lead.end.y - lead.anchor.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return null
  for (let reach = length; reach <= lead.limit; reach += GROUND_LEAD_STEP) {
    const p = { x: lead.anchor.x + (dx / length) * reach, y: lead.anchor.y + (dy / length) * reach }
    if (!onPad(p)) return p
  }
  return null
}

export const manhattanStrategy: Strategy = {
  id: 'manhattan',
  label: 'Manhattan – pads on a ground plane',
  description: 'One standard pad per net glued onto the board, which itself is ground; parts go where the schematic has them',
  rectHandles: true,
  run: manhattanLayout,
}
