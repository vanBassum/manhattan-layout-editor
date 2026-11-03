import { inflate, rectsOverlap, snapToGrid, withoutFloatNoise } from '../model/geometry'
import { bodyBounds, defaultLeadEnds, toWorld } from '../model/layout'
import { pinEnds, type FullSchematic } from '../model/schematic'
import type { BuiltComponent, BuiltNetlist, Placement, Point, Rect, Settings } from '../model/types'
import type { PlacedPart } from './common'

/**
 * Board mm per schematic mm. The schematic is in mm and its symbols are drawn about as large as the
 * parts themselves (a resistor's pins are 10.16 mm apart, like an axial resistor's holes), so one to
 * one already gives roughly physical spacing. Spreading the parts further only stretches the leads:
 * every net has one pad, so leads that the schematic spreads along a rail all reach for that one pad.
 */
export const SCHEMATIC_SCALE = 1
/** Parts are placed on this grid, the same the pads are searched on. */
const PLACEMENT_GRID = 0.5
const QUARTER_TURNS = [0, 90, 180, 270]
/** Pushing pairs apart settles within a few rounds on any real board; more means it is going round in circles. */
const MAX_PUSH_ROUNDS = 200

type Axis = 'x' | 'y'

/** A part being placed, with where its pins ended in the schematic (scaled to the board) to keep it in that order. */
interface Candidate {
  component: BuiltComponent
  placement: Placement
  keepOut: Rect
  schematicCenter: Point
}

/**
 * Places every part where the user drew it in the schematic, scaled to the board, turned so its
 * leads point where the symbol's pins do. Parts that then overlap are pushed apart as little as
 * possible, keeping the schematic's left/right and top/bottom order.
 */
export function placeFromSchematic(netlist: BuiltNetlist, settings: Settings, schematic: FullSchematic): PlacedPart[] {
  const drawn = new Map(schematic.placements.map((p) => [p.ref, p]))
  const candidates = netlist.components.map((component): Candidate => {
    const placement = drawn.get(component.ref)
    if (!placement) throw new Error(`${component.ref} is not in the schematic`)
    const targets = pinEnds(component, placement).map((end) => ({ x: end.x * SCHEMATIC_SCALE, y: end.y * SCHEMATIC_SCALE }))
    const boardPlacement = bestQuarterTurn(component, targets)
    return { component, placement: boardPlacement, keepOut: keepOutOf(component, boardPlacement, settings), schematicCenter: centroid(targets) }
  })
  pushApart(candidates, settings)
  return candidates.map(({ component, placement, keepOut }) => ({
    component,
    placement,
    keepOut,
    ends: defaultLeadEnds(component.geometry).map((end) => toWorld(end, placement)),
  }))
}

/**
 * The quarter turn whose unbent lead ends come closest to `targets`, the symbol's pin ends in the
 * same order: a package whose pins are in another order than the symbol's still points each lead
 * the right way. The part is centered so the centroids of its lead ends and of the targets meet.
 */
export function bestQuarterTurn(component: BuiltComponent, targets: Point[]): Placement {
  const localEnds = defaultLeadEnds(component.geometry)
  const targetCenter = centroid(targets)
  let best: { placement: Placement; distance: number } | undefined
  for (const rotation of QUARTER_TURNS) {
    const turnedCenter = centroid(localEnds.map((end) => toWorld(end, { ref: component.ref, x: 0, y: 0, rotation })))
    const placement = {
      ref: component.ref,
      x: snapToGrid(targetCenter.x - turnedCenter.x, PLACEMENT_GRID),
      y: snapToGrid(targetCenter.y - turnedCenter.y, PLACEMENT_GRID),
      rotation,
    }
    const distance = localEnds.reduce((sum, end, k) => {
      const at = toWorld(end, placement)
      return sum + Math.hypot(at.x - targets[k].x, at.y - targets[k].y)
    }, 0)
    if (!best || distance < best.distance) best = { placement, distance }
  }
  return best!.placement
}

function keepOutOf(component: BuiltComponent, placement: Placement, settings: Settings): Rect {
  const { geometry } = component
  return inflate(bodyBounds(geometry, placement, defaultLeadEnds(geometry)), settings.clearance / 2)
}

function centroid(points: Point[]): Point {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  }
}

/** Pushes overlapping pairs apart, round after round, until no keep-outs overlap. */
function pushApart(candidates: Candidate[], settings: Settings) {
  for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
    let pushed = false
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (!rectsOverlap(candidates[i].keepOut, candidates[j].keepOut)) continue
        pushPair(candidates[i], candidates[j], settings)
        pushed = true
      }
    }
    if (!pushed) return
  }
  const stuck = candidates.find((a) => candidates.some((b) => b !== a && rectsOverlap(a.keepOut, b.keepOut)))!
  throw new Error(`No free spot found for ${stuck.component.ref}`)
}

/**
 * Moves two overlapping parts apart along the axis that takes the shortest push, each half the way,
 * so that afterwards they lie in the order the schematic has them on that axis. Parts level with
 * each other in the schematic go whichever way is shorter.
 */
function pushPair(a: Candidate, b: Candidate, settings: Settings) {
  const options: { axis: Axis; first: Candidate; second: Candidate; distance: number }[] = []
  for (const axis of ['x', 'y'] as const) {
    const orders = schematicOrders(a, b, axis)
    for (const [first, second] of orders) options.push({ axis, first, second, distance: pushToOrder(first.keepOut, second.keepOut, axis) })
  }
  const shortest = options.reduce((best, option) => (option.distance < best.distance ? option : best))
  const half = Math.ceil(shortest.distance / 2 / PLACEMENT_GRID) * PLACEMENT_GRID
  move(shortest.first, shortest.axis, -half, settings)
  move(shortest.second, shortest.axis, half, settings)
}

/** Which of the two comes first on `axis` in the schematic; both orders when they are level. */
function schematicOrders(a: Candidate, b: Candidate, axis: Axis): [Candidate, Candidate][] {
  const difference = a.schematicCenter[axis] - b.schematicCenter[axis]
  if (Math.abs(difference) < 1e-6) return [[a, b], [b, a]]
  return difference < 0 ? [[a, b]] : [[b, a]]
}

/** How far `second` has to move past `first` on `axis` to lie wholly after it. */
function pushToOrder(first: Rect, second: Rect, axis: Axis): number {
  return axis === 'x' ? first.x + first.w - second.x : first.y + first.h - second.y
}

function move(candidate: Candidate, axis: Axis, distance: number, settings: Settings) {
  candidate.placement = { ...candidate.placement, [axis]: withoutFloatNoise(candidate.placement[axis] + distance) }
  candidate.keepOut = keepOutOf(candidate.component, candidate.placement, settings)
}
