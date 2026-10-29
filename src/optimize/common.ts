import { boundsOf, inflate, rectContains, rectsOverlap, segmentsCross } from '../geometry'
import { bodyBounds, componentGeometry, defaultLeadEnds, solderPoint, toLocal, toWorld, type Geometry } from '../layout'
import { isRealNet, naturalCompare } from '../netlist'
import type { Island, NetComponent, Netlist, Placement, Point, Rect, Settings } from '../types'

export function componentNets(component: NetComponent): string[] {
  return [...new Set(component.pins.map((p) => p.net).filter(isRealNet))].sort(naturalCompare)
}

export function netPinCounts(netlist: Netlist): Map<string, number> {
  const counts = new Map<string, number>()
  for (const c of netlist.components) for (const p of c.pins) counts.set(p.net, (counts.get(p.net) ?? 0) + 1)
  return counts
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
  component: NetComponent
  geometry: Geometry
  placement: Placement
  ends: Point[]
  /** Body and leads in world coordinates, grown by half the clearance on every side. */
  keepOut: Rect
}

interface Candidate {
  cost: number
  part: PlacedPart
  /** Lines from this part's leads to the nearest placed lead of the same net. */
  edges: [Point, Point][]
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
function placementOrder(netlist: Netlist): NetComponent[] {
  const pinCounts = netPinCounts(netlist)
  const netWeight = (net: string) => 1 / Math.max(1, (pinCounts.get(net) ?? 2) - 1)
  const link = (a: NetComponent, b: NetComponent) => {
    const nets = new Set(componentNets(b))
    return componentNets(a).reduce((sum, net) => sum + (nets.has(net) ? netWeight(net) : 0), 0)
  }
  const totalLink = (c: NetComponent, others: NetComponent[]) =>
    others.reduce((sum, o) => sum + (o === c ? 0 : link(c, o)), 0)
  const remaining = [...netlist.components].sort((a, b) => b.pins.length - a.pins.length || naturalCompare(a.ref, b.ref))

  const order: NetComponent[] = []
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

export interface PlacementOptions {
  step?: number
  rotations?: number[]
}

/**
 * Places components before any copper exists. Each part goes where its leads end up closest to
 * already placed leads of the same nets (those will share an island), with a penalty for every
 * crossing of those connections. Bodies plus leads never overlap and keep `settings.clearance`
 * apart; the search radius grows until a free spot is found, so that always holds.
 */
export function placeComponents(netlist: Netlist, settings: Settings, options: PlacementOptions = {}): PlacedPart[] {
  const { step = 1, rotations = ROTATIONS } = options
  const placed: PlacedPart[] = []
  const netEnds = new Map<string, Point[]>()
  const connections: [Point, Point][] = []

  for (const component of placementOrder(netlist)) {
    const geometry = componentGeometry(component)
    const localEnds = defaultLeadEnds(geometry)
    const nets = component.pins.map((p) => (isRealNet(p.net) ? p.net : null))
    const target = placementTarget(nets, netEnds, placed, step)

    let best: Candidate | undefined
    for (const radius of SEARCH_RADII) {
      for (const offset of spiralOffsets(radius, step)) {
        for (const rotation of rotations) {
          const placement = { ref: component.ref, x: target.x + offset.x, y: target.y + offset.y, rotation }
          const keepOut = inflate(bodyBounds(geometry, placement, localEnds), settings.clearance / 2)
          if (placed.some((p) => rectsOverlap(p.keepOut, keepOut))) continue
          const ends = localEnds.map((p) => toWorld(p, placement))
          if (endsTooClose(ends, nets, placed)) continue

          let cost = COMPACTNESS * Math.hypot(offset.x, offset.y)
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
          if (!best || cost < best.cost) best = { cost, part: { component, geometry, placement, ends, keepOut }, edges }
        }
      }
      if (best) break
    }
    const chosen = best as Candidate | undefined
    if (!chosen) throw new Error(`No free spot found for ${component.ref}`)

    placed.push(chosen.part)
    connections.push(...chosen.edges)
    chosen.part.ends.forEach((end, k) => {
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
export function placeOnIslands(netlist: Netlist, islands: Island[], settings: Settings): Placement[] {
  const islandsByNet = new Map(islands.map((i) => [i.net, i]))
  const placed: PlacedPart[] = []
  const placements: Placement[] = []

  for (const component of placementOrder(netlist)) {
    const geometry = componentGeometry(component)
    const localEnds = defaultLeadEnds(geometry)
    const limit = leadLimit(geometry, settings)
    const nets = component.pins.map((p) => (isRealNet(p.net) ? p.net : null))
    const own = componentNets(component).flatMap((net) => islandsByNet.get(net) ?? [])
    const target = own.length > 0 ? islandsMeetingPoint(own) : { x: 0, y: 0 }

    let best: { cost: number; part: PlacedPart; leads: Record<string, Point> } | undefined
    for (const radius of SEARCH_RADII) {
      for (const offset of spiralOffsets(radius, 1)) {
        for (const rotation of ROTATIONS) {
          const placement = { ref: component.ref, x: Math.round(target.x) + offset.x, y: Math.round(target.y) + offset.y, rotation }
          const keepOut = inflate(bodyBounds(geometry, placement, localEnds), settings.clearance / 2)
          if (placed.some((p) => rectsOverlap(p.keepOut, keepOut))) continue
          const ends = localEnds.map((p) => toWorld(p, placement))

          let cost = COMPACTNESS * Math.hypot(offset.x, offset.y)
          let feasible = true
          const leads: Record<string, Point> = {}
          ends.forEach((end, k) => {
            const net = nets[k]
            const island = net === null ? undefined : islandsByNet.get(net)
            if (!island) return
            const onOwn = island.rects.some((r) => rectContains(r, end))
            const finalEnd = onOwn ? end : solderPoint(island, toWorld(geometry.anchors[k], placement), geometry)
            const onForeign = islands.some((i) => i.net !== net && !i.plane && i.rects.some((r) => rectContains(r, finalEnd)))
            if (onForeign) feasible = false
            const anchor = toWorld(geometry.anchors[k], placement)
            cost += leadCost(Math.hypot(finalEnd.x - anchor.x, finalEnd.y - anchor.y), limit)
            if (!onOwn) leads[component.pins[k].number] = toLocal(finalEnd, placement)
          })
          if (!feasible) continue
          const finalEnds = ends.map((end, k) => (leads[component.pins[k].number] ? toWorld(leads[component.pins[k].number], placement) : end))
          if (endsTooClose(finalEnds, nets, placed)) continue
          if (!best || cost < best.cost) best = { cost, part: { component, geometry, placement, ends: finalEnds, keepOut }, leads }
        }
      }
      if (best) break
    }
    const chosen = best as typeof best
    if (!chosen) throw new Error(`No free spot found for ${component.ref}`)
    placed.push(chosen.part)
    placements.push(Object.keys(chosen.leads).length > 0 ? { ...chosen.part.placement, leads: chosen.leads } : chosen.part.placement)
  }
  return placements
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
function placementTarget(nets: (string | null)[], netEnds: Map<string, Point[]>, placed: PlacedPart[], step: number): Point {
  const snap = (v: number) => Math.round(v / step) * step
  const related = nets.flatMap((net) => (net === null ? [] : (netEnds.get(net) ?? [])))
  if (related.length > 0) {
    return {
      x: snap(related.reduce((s, p) => s + p.x, 0) / related.length),
      y: snap(related.reduce((s, p) => s + p.y, 0) / related.length),
    }
  }
  const bounds = boundsOf(placed.map((p) => p.keepOut))
  return bounds ? { x: snap(bounds.x + bounds.w + 10), y: snap(bounds.y) } : { x: 0, y: 0 }
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

/** Board area: everything placed, plus a margin. */
export function boardBounds(parts: PlacedPart[], margin: number): Rect {
  return inflate(boundsOf(parts.map((p) => p.keepOut)) ?? { x: 0, y: 0, w: 10, h: 10 }, margin)
}

/** Lead ends that should land on copper, grouped per net. */
export function endsByNet(parts: PlacedPart[]): Map<string, Point[]> {
  const result = new Map<string, Point[]>()
  for (const part of parts) {
    part.ends.forEach((end, k) => {
      const net = part.component.pins[k].net
      if (isRealNet(net)) result.set(net, [...(result.get(net) ?? []), end])
    })
  }
  return result
}
