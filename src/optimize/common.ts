import { boundsOf, inflate, rectsOverlap, segmentsCross } from '../model/geometry'
import { bodyBounds, defaultLeadEnds, onCopper, solderPoint, toLocal, toWorld } from '../model/layout'
import { isRealNet, naturalCompare, pinsByNet } from '../model/netlist'
import type { BuiltComponent, BuiltNetlist, Geometry, Island, NetComponent, Placement, Point, Rect, Settings } from '../model/types'

export function componentNets(component: NetComponent): string[] {
  return [...new Set(component.pins.map((p) => p.net).filter(isRealNet))].sort(naturalCompare)
}

/** Lead cost that rises gently up to the limit and sharply beyond it. */
export function leadCost(length: number, limit: number): number {
  return length + (length > limit ? 20 * (length - limit) ** 2 : 0)
}

export function leadLimit(geometry: Geometry, settings: Settings): number {
  return Math.min(geometry.maxLeadLength, settings.maxLead)
}

/** Candidate offsets within `radius`, nearest first. */
export function spiralOffsets(radius: number, step: number): Point[] {
  const offsets: Point[] = []
  const steps = Math.floor(radius / step)
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const p = { x: i * step, y: j * step }
      if (Math.hypot(p.x, p.y) <= radius) offsets.push(p)
    }
  }
  return offsets.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))
}

// ---------- Component placement ----------

/** A component placed by the optimizer, with its unbent lead ends in world coordinates. */
export interface PlacedPart {
  component: BuiltComponent
  geometry: Geometry
  placement: Placement
  ends: Point[]
  /** Body and leads in world coordinates, grown by half the clearance on every side. */
  keepOut: Rect
}

/** What a strategy makes of a free spot: its cost and where the part's leads end, bent or not. */
interface Spot {
  cost: number
  ends: Point[]
}

/** Lead ends of different nets stay this far apart: room for two pads, solder and a probe tip. */
const MIN_END_SPACING = 2.5
const CROSSING_PENALTY = 15
/** Small pull toward the target; deliberately weak, since a roomy board is easier to build. */
const COMPACTNESS = 0.05
const ROTATIONS = [0, 45, 90, 135, 180, 225, 270, 315]
const SEARCH_RADII = [15, 30, 60, 120, 240]

/**
 * Busy nets (ground, supply) connect almost everything, so a shared net counts for less the more
 * pins it has. Two parts sharing a private two-pin net are the most closely related.
 */
function placementOrder(netlist: BuiltNetlist): BuiltComponent[] {
  const pinsOnNet = pinsByNet(netlist)
  const netWeight = (net: string) => 1 / Math.max(1, (pinsOnNet.get(net)?.length ?? 2) - 1)
  const link = (a: BuiltComponent, b: BuiltComponent) => {
    const nets = new Set(componentNets(b))
    return componentNets(a).reduce((sum, net) => sum + (nets.has(net) ? netWeight(net) : 0), 0)
  }
  const totalLink = (c: BuiltComponent, others: BuiltComponent[]) =>
    others.reduce((sum, o) => sum + (o === c ? 0 : link(c, o)), 0)
  const remaining = [...netlist.components].sort((a, b) => b.pins.length - a.pins.length || naturalCompare(a.ref, b.ref))

  const order: BuiltComponent[] = []
  let first = 0
  for (let k = 1; k < remaining.length; k++) {
    if (totalLink(remaining[k], remaining) > totalLink(remaining[first], remaining)) first = k
  }
  order.push(...remaining.splice(first, 1))
  while (remaining.length > 0) {
    let best = 0
    for (let k = 1; k < remaining.length; k++) {
      if (totalLink(remaining[k], order) > totalLink(remaining[best], order)) best = k
    }
    order.push(...remaining.splice(best, 1))
  }
  return order
}

/**
 * Places components before any copper exists. Each part goes where its leads end up closest to
 * already placed leads of the same nets (those will share an island), with a penalty for every
 * crossing of those connections. Bodies plus leads never overlap and keep `settings.clearance`
 * apart; the search radius grows until a free spot is found, so that always holds.
 */
export function placeComponents(netlist: BuiltNetlist, settings: Settings): PlacedPart[] {
  const placed: PlacedPart[] = []
  const netEnds = new Map<string, Point[]>()
  const connections: [Point, Point][] = []

  for (const component of placementOrder(netlist)) {
    const nets = leadNets(component)
    const target = placementTarget(nets, netEnds, placed)

    const { part, spot } = findBestSpot(component, target, placed, settings, (_placement, ends, offset) => {
      let cost = COMPACTNESS * Math.hypot(offset.x, offset.y)
      // Lines from this part's leads to the nearest placed lead of the same net.
      const edges: [Point, Point][] = []
      ends.forEach((end, k) => {
        const net = nets[k]
        const others = net === null ? undefined : netEnds.get(net)
        if (!others) return
        const nearest = nearestPoint(others, end)
        cost += Math.hypot(nearest.x - end.x, nearest.y - end.y)
        edges.push([end, nearest])
      })
      for (const [a, b] of edges) {
        for (const [c, d] of connections) if (segmentsCross(a, b, c, d)) cost += CROSSING_PENALTY
      }
      return { cost, ends, edges }
    })

    placed.push(part)
    connections.push(...spot.edges)
    part.ends.forEach((end, k) => {
      const net = nets[k]
      if (net !== null) netEnds.set(net, [...(netEnds.get(net) ?? []), end])
    })
  }
  return placed
}

/**
 * Places components onto islands that already exist (for strategies that must lay out the copper
 * first). Same collision rules as placeComponents; each lead that misses its island is bent onto
 * it, and a lead may never end on another net's copper.
 */
export function placeOnIslands(netlist: BuiltNetlist, islands: Island[], settings: Settings): Placement[] {
  const islandsByNet = new Map(islands.map((i) => [i.net, i]))
  const placed: PlacedPart[] = []
  const placements: Placement[] = []

  for (const component of placementOrder(netlist)) {
    const { geometry } = component
    const limit = leadLimit(geometry, settings)
    const nets = leadNets(component)
    const own = componentNets(component).flatMap((net) => islandsByNet.get(net) ?? [])
    const meetingPoint = own.length > 0 ? islandsMeetingPoint(own) : { x: 0, y: 0 }
    const target = { x: Math.round(meetingPoint.x), y: Math.round(meetingPoint.y) }

    const { part, spot } = findBestSpot(component, target, placed, settings, (placement, ends, offset) => {
      let cost = COMPACTNESS * Math.hypot(offset.x, offset.y)
      const leads: Record<string, Point> = {}
      for (const [k, end] of ends.entries()) {
        const net = nets[k]
        const island = net === null ? undefined : islandsByNet.get(net)
        if (!island) continue
        const anchor = toWorld(geometry.anchors[k], placement)
        const onOwn = onCopper(island, end, settings.isolation)
        const finalEnd = onOwn ? end : solderPoint(island, anchor, geometry, settings.isolation)
        const onForeign = islands.some((i) => i.net !== net && !i.plane && onCopper(i, finalEnd, settings.isolation))
        if (onForeign) return null
        cost += leadCost(Math.hypot(finalEnd.x - anchor.x, finalEnd.y - anchor.y), limit)
        if (!onOwn) leads[component.pins[k].number] = toLocal(finalEnd, placement)
      }
      const finalEnds = ends.map((end, k) => (leads[component.pins[k].number] ? toWorld(leads[component.pins[k].number], placement) : end))
      return { cost, ends: finalEnds, leads }
    })

    placed.push(part)
    placements.push(Object.keys(spot.leads).length > 0 ? { ...part.placement, leads: spot.leads } : part.placement)
  }
  return placements
}

/** Each lead's net, or null for a pin on no net. */
function leadNets(component: BuiltComponent): (string | null)[] {
  return component.pins.map((p) => (isRealNet(p.net) ? p.net : null))
}

/**
 * The cheapest spot around `target` where the part's body and unbent leads keep clear of the placed
 * parts and its lead ends stay apart from other nets' ends. `score` prices a free spot, or rules
 * it out with null. The search radius grows until some spot is found; on a tie the spot found
 * first, nearest the target, wins.
 */
function findBestSpot<S extends Spot>(
  component: BuiltComponent,
  target: Point,
  placed: PlacedPart[],
  settings: Settings,
  score: (placement: Placement, unbentEnds: Point[], offset: Point) => S | null,
): { part: PlacedPart; spot: S } {
  const { geometry } = component
  const localEnds = defaultLeadEnds(geometry)
  const nets = leadNets(component)
  let best: { part: PlacedPart; spot: S } | undefined
  for (const radius of SEARCH_RADII) {
    for (const offset of spiralOffsets(radius, 1)) {
      for (const rotation of ROTATIONS) {
        const placement = { ref: component.ref, x: target.x + offset.x, y: target.y + offset.y, rotation }
        const keepOut = inflate(bodyBounds(geometry, placement, localEnds), settings.clearance / 2)
        if (placed.some((p) => rectsOverlap(p.keepOut, keepOut))) continue
        const spot = score(placement, localEnds.map((p) => toWorld(p, placement)), offset)
        if (!spot || endsTooClose(spot.ends, nets, placed)) continue
        if (!best || spot.cost < best.spot.cost) best = { part: { component, geometry, placement, ends: spot.ends, keepOut }, spot }
      }
    }
    if (best) return best
  }
  throw new Error(`No free spot found for ${component.ref}`)
}

function closestOnAxis(a0: number, a1: number, b0: number, b1: number): [number, number] {
  const lo = Math.max(a0, b0)
  const hi = Math.min(a1, b1)
  if (lo <= hi) return [(lo + hi) / 2, (lo + hi) / 2]
  return a1 < b0 ? [a1, b0] : [a0, b1]
}

/** Average of the points where each pair of islands comes closest: where a part bridging them belongs. */
function islandsMeetingPoint(islands: Island[]): Point {
  if (islands.length === 1) {
    const r = islands[0].rects[0]
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  }
  const points: Point[] = []
  for (let a = 0; a < islands.length; a++) {
    for (let b = a + 1; b < islands.length; b++) {
      let best = { x: 0, y: 0 }
      let bestDistance = Infinity
      for (const ra of islands[a].rects) {
        for (const rb of islands[b].rects) {
          const [ax, bx] = closestOnAxis(ra.x, ra.x + ra.w, rb.x, rb.x + rb.w)
          const [ay, by] = closestOnAxis(ra.y, ra.y + ra.h, rb.y, rb.y + rb.h)
          const d = Math.hypot(ax - bx, ay - by)
          if (d < bestDistance) {
            bestDistance = d
            best = { x: (ax + bx) / 2, y: (ay + by) / 2 }
          }
        }
      }
      points.push(best)
    }
  }
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  }
}

function nearestPoint(points: Point[], p: Point): Point {
  return points.reduce((a, b) => (Math.hypot(b.x - p.x, b.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? b : a))
}

/** Centroid of already placed leads on the same nets; unconnected parts go to the right of the rest. */
function placementTarget(nets: (string | null)[], netEnds: Map<string, Point[]>, placed: PlacedPart[]): Point {
  const related = nets.flatMap((net) => (net === null ? [] : (netEnds.get(net) ?? [])))
  if (related.length > 0) {
    return {
      x: Math.round(related.reduce((s, p) => s + p.x, 0) / related.length),
      y: Math.round(related.reduce((s, p) => s + p.y, 0) / related.length),
    }
  }
  const bounds = boundsOf(placed.map((p) => p.keepOut))
  return bounds ? { x: Math.round(bounds.x + bounds.w + 10), y: Math.round(bounds.y) } : { x: 0, y: 0 }
}

function endsTooClose(ends: Point[], nets: (string | null)[], placed: PlacedPart[]): boolean {
  return ends.some((end, k) =>
    placed.some((other) =>
      other.ends.some((otherEnd, m) => {
        const otherNet = other.component.pins[m].net
        return otherNet !== nets[k] && Math.hypot(otherEnd.x - end.x, otherEnd.y - end.y) < MIN_END_SPACING
      }),
    ),
  )
}
