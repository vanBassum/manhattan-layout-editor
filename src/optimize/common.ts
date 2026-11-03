import { withoutFloatNoise } from '../model/geometry'
import { onCopper, solderPoint, toLocal, toWorld } from '../model/layout'
import { isRealNet } from '../model/netlist'
import type { BuiltComponent, Geometry, Island, Placement, Point, Rect, Settings } from '../model/types'

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

/** The smallest rectangle with edges on the grid that contains `r`. */
export function gridOutward(r: Rect, step: number): Rect {
  const left = Math.floor(r.x / step) * step
  const top = Math.floor(r.y / step) * step
  const right = Math.ceil((r.x + r.w) / step) * step
  const bottom = Math.ceil((r.y + r.h) / step) * step
  return { x: withoutFloatNoise(left), y: withoutFloatNoise(top), w: withoutFloatNoise(right - left), h: withoutFloatNoise(bottom - top) }
}

/** A part placed by a placement algorithm, with its unbent lead ends in world coordinates. */
export interface PlacedPart {
  component: BuiltComponent
  placement: Placement
  ends: Point[]
  /** Body and leads in world coordinates, grown by half the clearance on every side. */
  keepOut: Rect
}

/** A lead of a placed part that is on a net, in world coordinates. */
export interface Lead {
  part: PlacedPart
  index: number
  net: string
  anchor: Point
  end: Point
  limit: number
}

/** Every lead on a net; a pin on no net is left where it is. */
export function leadsOf(parts: PlacedPart[], settings: Settings): Lead[] {
  return parts.flatMap((part) => {
    const { geometry } = part.component
    return part.component.pins.flatMap((pin, index) =>
      isRealNet(pin.net)
        ? [{ part, index, net: pin.net, anchor: toWorld(geometry.anchors[index], part.placement), end: part.ends[index], limit: leadLimit(geometry, settings) }]
        : [],
    )
  })
}

/** Where a lead has to be bent to land on `island`, or null when it already does. */
export function bendOnto(island: Island, lead: Lead, isolation: number): Point | null {
  if (onCopper(island, lead.end, isolation)) return null
  return solderPoint(island, lead.anchor, lead.part.component.geometry, isolation)
}

/** The parts' placements with each lead bent to where `bentEnd` says; null leaves a lead as it is. */
export function withBentLeads(parts: PlacedPart[], leads: Lead[], bentEnd: (lead: Lead) => Point | null): Placement[] {
  return parts.map((part) => {
    const bent: Record<string, Point> = {}
    for (const lead of leads.filter((l) => l.part === part)) {
      const end = bentEnd(lead)
      if (end) bent[part.component.pins[lead.index].number] = toLocal(end, part.placement)
    }
    return Object.keys(bent).length > 0 ? { ...part.placement, leads: bent } : part.placement
  })
}
