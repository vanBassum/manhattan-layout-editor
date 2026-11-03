import { boundsOf, coversSquare, rectsOverlap, rotatePoint, snapToGrid, withoutFloatNoise } from './geometry'
import { footprintPinCount } from './footprints'
import { isRealNet, pinsByNet } from './netlist'
import type { BuiltComponent, BuiltNetlist, Geometry, Island, Layout, NetComponent, Netlist, Placement, Point, Rect } from './types'

const ISLAND_WIDTH = 12
const ISLAND_HEIGHT = 8
const ISLAND_SPACING = 4
const PART_SPACING = 6

export function defaultLeadEnds(geometry: Geometry): Point[] {
  return geometry.anchors.map((a, k) => ({
    x: a.x + geometry.directions[k].x * geometry.leadLength,
    y: a.y + geometry.directions[k].y * geometry.leadLength,
  }))
}

export function toWorld(local: Point, placement: Placement): Point {
  const p = rotatePoint(local, placement.rotation)
  return { x: placement.x + p.x, y: placement.y + p.y }
}

export function toLocal(world: Point, placement: Placement): Point {
  return rotatePoint({ x: world.x - placement.x, y: world.y - placement.y }, -placement.rotation)
}

/**
 * Islands are stored touching each other; the isolation cut is burned centered on their edges, so
 * the copper that remains is each island shrunk by isolation/2. A point is on the copper when the
 * whole cut-wide square around it is inside the island.
 */
function onCopper(island: Island, p: Point, isolation: number): boolean {
  return coversSquare(island.rects, p, isolation / 2)
}

/** World-space bounding box of the body, and optionally extra local points such as lead ends. */
export function bodyBounds(geometry: Geometry, placement: Placement, extraLocalPoints: Point[] = []): Rect {
  const { x, y, w, h } = geometry.body
  const corners = [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }, ...extraLocalPoints]
  return boundsOf(corners.map((p) => ({ ...toWorld(p, placement), w: 0, h: 0 })))!
}

// ---------- Moving parts and islands ----------

export function replaceIslandRects(layout: Layout, net: string, rects: Rect[]): Layout {
  return { ...layout, islands: layout.islands.map((i) => (i.net === net ? { ...i, rects } : i)) }
}

export function replaceRect(layout: Layout, net: string, rectIndex: number, rect: Rect): Layout {
  return {
    ...layout,
    islands: layout.islands.map((i) => (i.net === net ? { ...i, rects: i.rects.map((r, k) => (k === rectIndex ? rect : r)) } : i)),
  }
}

export const moveRects = (rects: Rect[], dx: number, dy: number) =>
  rects.map((r) => ({ ...r, x: withoutFloatNoise(r.x + dx), y: withoutFloatNoise(r.y + dy) }))

/** The delta that puts the first rectangle's top-left corner on the snap grid; the rest follow it. */
export function gridDelta(rects: Rect[], dx: number, dy: number, snap: number): Point {
  const first = rects[0]
  return { x: snapToGrid(first.x + dx, snap) - first.x, y: snapToGrid(first.y + dy, snap) - first.y }
}

/** A part as it was when a move started. With worldLeadEnds set, only the body moves. */
export interface MovingPart {
  placement: Placement
  worldLeadEnds?: Record<string, Point>
}

/** `current` moved to where `moving` started plus the delta. */
export function movePart(current: Placement, moving: MovingPart, dx: number, dy: number): Placement {
  const moved = { ...current, x: moving.placement.x + dx, y: moving.placement.y + dy }
  if (!moving.worldLeadEnds) return moved
  // Leads are stored relative to the body, so keeping their ends in place means re-bending them.
  const leads = Object.fromEntries(Object.entries(moving.worldLeadEnds).map(([pin, end]) => [pin, toLocal(end, moved)]))
  return { ...moved, leads }
}

/** Moves the parts and islands, as they were when the move started, by the same delta. */
export function moveGroup(layout: Layout, parts: MovingPart[], islands: Island[], dx: number, dy: number): Layout {
  const partsByRef = new Map(parts.map((part) => [part.placement.ref, part]))
  const islandsByNet = new Map(islands.map((island) => [island.net, island]))
  return {
    placements: layout.placements.map((pl) => {
      const moving = partsByRef.get(pl.ref)
      return moving ? movePart(pl, moving, dx, dy) : pl
    }),
    islands: layout.islands.map((island) => {
      const original = islandsByNet.get(island.net)
      return original ? { ...island, rects: moveRects(original.rects, dx, dy) } : island
    }),
  }
}

// ---------- Leads and checks ----------

/**
 * ok: lead ends on its own net's copper. open: it does not (a lead on the cut between two islands
 * is open). short: it ends on another net's copper.
 */
export type PinStatus = 'ok' | 'open' | 'short' | 'unused'

export interface LeadInfo {
  /** Where the lead leaves the body (world coordinates). */
  anchor: Point
  /** Where the lead is soldered (world coordinates). */
  end: Point
  net: string
  status: PinStatus
}

/**
 * Islands under a point that it actually makes contact with. A pad glued onto the ground plane
 * insulates whatever is soldered to it from the plane underneath.
 */
function contactIslands(islands: Island[], p: Point, isolation: number): Island[] {
  const touched = islands.filter((i) => onCopper(i, p, isolation))
  const onTop = touched.filter((i) => !i.plane)
  return onTop.length > 0 ? onTop : touched
}

/** Leads keep their shape relative to the body; the netlist decides which island each should reach. */
export function analyzeLeads(
  component: BuiltComponent,
  placement: Placement,
  islands: Island[],
  isolation: number,
): LeadInfo[] {
  const { geometry } = component
  const defaults = defaultLeadEnds(geometry)
  return component.pins.map((pin, k) => {
    const anchor = toWorld(geometry.anchors[k], placement)
    const end = toWorld(placement.leads?.[pin.number] ?? defaults[k], placement)
    const touched = contactIslands(islands, end, isolation)
    let status: PinStatus
    if (touched.some((i) => i.net !== pin.net)) status = 'short'
    else if (!isRealNet(pin.net)) status = 'unused'
    else status = touched.length > 0 ? 'ok' : 'open'
    return { anchor, end, net: pin.net, status }
  })
}


/**
 * Grid placement. Islands and placements from `previous` whose net/ref still exist are kept as-is,
 * so re-importing an edited netlist does not destroy manual work.
 */
export function createLayout(netlist: BuiltNetlist, previous?: Layout): Layout {
  const keptIslands = (previous?.islands ?? []).filter((i) => netlist.nets.includes(i.net))
  const components = new Map(netlist.components.map((c) => [c.ref, c]))
  const keptPlacements = (previous?.placements ?? []).flatMap((p) => {
    const component = components.get(p.ref)
    if (!component) return []
    // A footprint choice survives a re-import unless the part's pin count changed so it no longer
    // fits. Only library footprints have a known pin count; other names are kept unchecked.
    const chosenPins = p.footprint ? footprintPinCount(p.footprint) : undefined
    return chosenPins !== undefined && chosenPins !== component.pins.length ? [{ ...p, footprint: undefined }] : [p]
  })
  const keptBounds = boundsOf(keptIslands.flatMap((i) => i.rects))
  const originY = keptBounds ? keptBounds.y + keptBounds.h + 10 : 0

  const newNets = netlist.nets.filter((net) => !keptIslands.some((i) => i.net === net))
  const islandColumns = Math.max(1, Math.ceil(Math.sqrt(netlist.nets.length)))
  const newIslands: Island[] = newNets.map((net, k) => ({
    net,
    rects: [
      {
        x: (k % islandColumns) * (ISLAND_WIDTH + ISLAND_SPACING),
        y: originY + Math.floor(k / islandColumns) * (ISLAND_HEIGHT + ISLAND_SPACING),
        w: ISLAND_WIDTH,
        h: ISLAND_HEIGHT,
      },
    ],
  }))

  const newParts = netlist.components.filter((c) => !keptPlacements.some((p) => p.ref === c.ref))
  const bodies = newParts.map((c) => c.geometry.body)
  const cellWidth = Math.max(10, ...bodies.map((b) => b.w + 4)) + PART_SPACING
  const cellHeight = Math.max(6, ...bodies.map((b) => b.h)) + PART_SPACING
  const partColumns = Math.max(1, Math.ceil(Math.sqrt(newParts.length)))
  const partsX = islandColumns * (ISLAND_WIDTH + ISLAND_SPACING) + 10
  const newPlacements: Placement[] = newParts.map((c, k) => ({
    ref: c.ref,
    x: partsX + (k % partColumns) * cellWidth + cellWidth / 2,
    y: originY + Math.floor(k / partColumns) * cellHeight + cellHeight / 2,
    rotation: 0,
  }))

  return { islands: [...keptIslands, ...newIslands], placements: [...keptPlacements, ...newPlacements] }
}

/**
 * The layout after the netlist's connections changed (in the schematic). An island whose net
 * disappeared moves over to the new net that took most of its pins, so renaming a net or joining
 * two keeps the copper; parts and nets that are new get a spot on the grid.
 */
export function followNetlist(layout: Layout, before: Netlist, after: BuiltNetlist): Layout {
  const sameNets = after.components.every((c, i) => c.pins.every((p, k) => p.net === before.components[i]?.pins[k]?.net))
  if (sameNets && after.components.length === before.components.length) return layout
  const oldPins = pinsByNet(before)
  const newPins = pinsByNet(after)
  const kept = new Set(layout.islands.map((i) => i.net).filter((net) => newPins.has(net)))
  const renamed = new Map<string, string>()
  for (const island of layout.islands) {
    if (kept.has(island.net)) continue
    const pins = new Set(oldPins.get(island.net))
    let best: string | undefined
    let bestShared = 0
    for (const [net, netPins] of newPins) {
      if (kept.has(net) || [...renamed.values()].includes(net)) continue
      const shared = netPins.filter((p) => pins.has(p)).length
      if (shared > bestShared) [best, bestShared] = [net, shared]
    }
    if (best) renamed.set(island.net, best)
  }
  const islands = layout.islands.map((i) => (renamed.has(i.net) ? { ...i, net: renamed.get(i.net)! } : i))
  return { ...layout, ...createLayout(after, { ...layout, islands }) }
}

// ---------- Footprint choices ----------

/** The netlist as built: footprints chosen in the editor replace the netlist's own. */
export function withFootprintChoices(netlist: Netlist, placements: Placement[]): Netlist {
  const chosen = new Map(placements.map((p) => [p.ref, p.footprint]))
  if (![...chosen.values()].some(Boolean)) return netlist
  return {
    ...netlist,
    components: netlist.components.map((c) => {
      const footprint = chosen.get(c.ref)
      return footprint ? { ...c, footprint } : c
    }),
  }
}

/** Copies the footprint choices of `from` onto a freshly generated layout, which knows nothing about them. */
export function keepFootprintChoices(layout: Layout, from: Layout): Layout {
  const chosen = new Map(from.placements.map((p) => [p.ref, p.footprint]))
  return { ...layout, placements: layout.placements.map((p) => ({ ...p, footprint: chosen.get(p.ref) })) }
}

/**
 * Builds the parts in `refs` with `footprint`, or with their netlist footprint again when it is
 * undefined. `imported` must be the netlist as imported, without choices applied: choosing a part's
 * own netlist footprint is stored as no choice. Bent leads are reset, since they fitted the old shape.
 */
export function changeFootprints(imported: Netlist, layout: Layout, refs: ReadonlySet<string>, footprint: string | undefined): Layout {
  const netlistFootprints = new Map(imported.components.map((c) => [c.ref, c.footprint]))
  return {
    ...layout,
    placements: layout.placements.map((p) => {
      if (!refs.has(p.ref)) return p
      const choice = footprint === netlistFootprints.get(p.ref) ? undefined : footprint
      return { ...p, footprint: choice, leads: undefined }
    }),
  }
}

export type ResistorChoice = 'through-hole' | '1206'

/** R1, R2, ... with an axial footprint. Trimmers (RV) and loads (RL) are left alone. */
const isPlainResistor = (c: NetComponent) => /^R\d+$/i.test(c.ref) && /AXIAL/i.test(c.footprint)

/** Builds every plain resistor through-hole (as in the netlist) or as a 1206 chip bridging the cut between two islands. */
export function chooseResistors(imported: Netlist, layout: Layout, choice: ResistorChoice): Layout {
  const resistors = new Set(imported.components.filter(isPlainResistor).map((c) => c.ref))
  return changeFootprints(imported, layout, resistors, choice === '1206' ? 'R1206' : undefined)
}

/** Nets whose island consists of separate pieces of copper; those need a wire jumper. */
export function findSplitNets(islands: Island[]): Set<string> {
  const split = new Set<string>()
  const eps = 1e-6
  for (const island of islands) {
    const { rects } = island
    const parent = rects.map((_, k) => k)
    const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])))
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const ra = rects[a]
        const rb = rects[b]
        const xOverlap = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x)
        const yOverlap = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y)
        // Overlapping or sharing an edge; touching at a single corner does not count.
        if (xOverlap >= -eps && yOverlap >= -eps && (xOverlap > eps || yOverlap > eps)) parent[root(a)] = root(b)
      }
    }
    if (new Set(rects.map((_, k) => root(k))).size > 1) split.add(island.net)
  }
  return split
}

/**
 * Nets whose island overlaps a different net's island. Touching is fine: the shared edge is where
 * the isolation is cut.
 */
export function findSpacingViolations(islands: Island[]): Set<string> {
  const violating = new Set<string>()
  for (let a = 0; a < islands.length; a++) {
    for (let b = a + 1; b < islands.length; b++) {
      // Pads glued onto a ground plane are insulated from it, so they may sit on top of it.
      if (islands[a].plane || islands[b].plane) continue
      const overlapping = islands[a].rects.some((ra) => islands[b].rects.some((rb) => rectsOverlap(ra, rb)))
      if (overlapping) {
        violating.add(islands[a].net)
        violating.add(islands[b].net)
      }
    }
  }
  return violating
}

/** Nets drawn as a problem: overlapping another net's island, or split into separate pieces. */
export const findProblemNets = (islands: Island[]): Set<string> => new Set([...findSpacingViolations(islands), ...findSplitNets(islands)])

export interface PinIssues {
  open: number
  short: number
  /** Parts with at least one open or shorted lead. */
  refsWithIssues: Set<string>
}

/** How many placed leads are open or shorted, and on which parts. */
export function findPinIssues(netlist: BuiltNetlist, layout: Layout, isolation: number): PinIssues {
  const issues: PinIssues = { open: 0, short: 0, refsWithIssues: new Set() }
  const components = new Map(netlist.components.map((c) => [c.ref, c]))
  for (const placement of layout.placements) {
    const component = components.get(placement.ref)
    if (!component) continue
    for (const lead of analyzeLeads(component, placement, layout.islands, isolation)) {
      if (lead.status === 'open') issues.open++
      if (lead.status === 'short') issues.short++
      if (lead.status === 'open' || lead.status === 'short') issues.refsWithIssues.add(component.ref)
    }
  }
  return issues
}
