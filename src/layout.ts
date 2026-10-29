import { boundsOf, coversSquare, inflate, nearestPointOnRects, rectsOverlap, rotatePoint } from './geometry'
import { footprintPinCount } from './footprints'
import { isRealNet } from './netlist'
import { cutsFromIslands, islandsFromCuts } from './raster'
import type { Island, Layout, NetComponent, Netlist, Placement, Point, Rect } from './types'

const PITCH = 2.54
const ISLAND_WIDTH = 12
const ISLAND_HEIGHT = 8
const ISLAND_SPACING = 4
const PART_SPACING = 6
/** Spacing of TO-92 legs where they leave the package (datasheet dimension G). */
const TO92_LEG_PITCH = 1.27
/** Automatic leads end this far inside the copper, so there is room for a solder joint. */
const SOLDER_INSET = 0.5

export type Shape = 'axial' | 'radial' | 'smd' | 'to92' | 'to126' | 'trimmer' | 'dip' | 'row'

/** Roughly how far a lead of each package can reach, in mm. Longer leads are flagged. */
const MAX_LEAD_LENGTH: Record<Shape, number> = {
  axial: 25,
  radial: 15,
  smd: 0.5,
  to92: 14,
  to126: 15,
  trimmer: 4,
  dip: 3.5,
  row: 5,
}

/** Imperial SMD chip size code to length x width in mm. */
const CHIP_SIZES: Record<string, [number, number]> = {
  '0201': [0.6, 0.3],
  '0402': [1.0, 0.5],
  '0603': [1.6, 0.8],
  '0805': [2.0, 1.25],
  '1206': [3.2, 1.6],
  '1210': [3.2, 2.5],
  '2512': [6.3, 3.2],
}

/**
 * Simple symbolic geometry in local coordinates (component center at 0,0, before rotation).
 * Not a footprint: each lead leaves the body at a fixed anchor and runs to its copper island.
 */
export interface Geometry {
  shape: Shape
  body: Rect
  anchors: Point[]
  /** Unit vectors pointing away from the body; used for leads that have no island to go to. */
  directions: Point[]
  /** How far the unbent leads stick out beyond the anchors. */
  leadLength: number
  maxLeadLength: number
  /** Drawn in its own color: an LED has the same round body as a capacitor can. */
  led: boolean
}

const isLed = (component: NetComponent) =>
  /LED/i.test(component.footprint) || /^LED/i.test(component.ref) || /^LED\b/i.test(component.value)

function shapeOf(component: NetComponent): Shape {
  const footprint = component.footprint.toUpperCase()
  if (/TO-?126|TO-?220/.test(footprint)) return 'to126'
  if (/TO-?92/.test(footprint)) return 'to92'
  if (/RES-ADJ|TRIM|POT/.test(footprint)) return 'trimmer'
  if (/DIP/.test(footprint)) return 'dip'
  if (/AXIAL|DO-?35|DO-?41|RES-TH/.test(footprint)) return 'axial'
  if (/SMD|SOT|SOD|SOIC|SOP|QFN|^[A-Z]*(0201|0402|0603|0805|1206|1210|2512)/.test(footprint)) return 'smd'
  if (/RADIAL|CAP-TH|CP_|ELEC/.test(footprint)) return 'radial'

  // No recognizable footprint: guess from reference prefix and pin count.
  const pinCount = component.pins.length
  const prefix = component.ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? ''
  if (pinCount === 2) return prefix === 'C' ? 'radial' : 'axial'
  if (pinCount === 3 && prefix === 'Q') return 'to92'
  if (pinCount >= 4 && pinCount % 2 === 0) return 'dip'
  return 'row'
}

/** EasyEDA footprint names carry dimensions like "L7.6-W2.7-P2.30" or "BD3.0". */
function footprintDimension(footprint: string, key: string): number | undefined {
  const match = footprint.toUpperCase().match(new RegExp(`(?:^|[-_])${key}(\\d+(?:\\.\\d+)?)`))
  return match ? Number(match[1]) : undefined
}

function chipSize(footprint: string): [number, number] | undefined {
  const code = footprint.match(/(0201|0402|0603|0805|1206|1210|2512)/)?.[1]
  return code ? CHIP_SIZES[code] : undefined
}

/** Leads in a row along the bottom edge of the body, pointing down. */
function rowLeads(pinCount: number, pitch: number, width: number, height: number) {
  const span = (pinCount - 1) * pitch
  return {
    body: { x: -width / 2, y: -height, w: width, h: height },
    anchors: Array.from({ length: pinCount }, (_, k) => ({ x: -span / 2 + k * pitch, y: 0 })),
    directions: Array.from({ length: pinCount }, () => ({ x: 0, y: 1 })),
  }
}

/** Two leads leaving the left and right ends of the body. */
function endLeads(length: number, width: number) {
  return {
    body: { x: -length / 2, y: -width / 2, w: length, h: width },
    anchors: [{ x: -length / 2, y: 0 }, { x: length / 2, y: 0 }],
    directions: [{ x: -1, y: 0 }, { x: 1, y: 0 }],
  }
}

function leadsFor(shape: Shape, component: NetComponent) {
  const footprint = component.footprint
  const pinCount = component.pins.length
  const length = footprintDimension(footprint, 'L')
  const width = footprintDimension(footprint, 'W')
  const pitch = footprintDimension(footprint, 'P') ?? PITCH

  switch (shape) {
    case 'axial':
      if (pinCount === 2) return endLeads(length ?? 6.3, width ?? footprintDimension(footprint, 'BD') ?? 2.3)
      break
    case 'radial': {
      // Seen from above; the leads come out underneath. Box capacitors give a length and width,
      // cans a body diameter ("BD" in EasyEDA, "D" in KiCad). A small EasyEDA "D" is the lead diameter.
      if (pinCount !== 2) break
      const d = footprintDimension(footprint, 'D')
      const diameter = footprintDimension(footprint, 'BD') ?? (d !== undefined && d >= 2 ? d : 5)
      const [bodyLength, bodyWidth] = length && width ? [length, width] : [diameter, diameter]
      const leadSpacing = footprintDimension(footprint, 'P') ?? bodyLength / 2
      return {
        body: { x: -bodyLength / 2, y: -bodyWidth / 2, w: bodyLength, h: bodyWidth },
        anchors: [{ x: -leadSpacing / 2, y: 0 }, { x: leadSpacing / 2, y: 0 }],
        directions: [{ x: -1, y: 0 }, { x: 1, y: 0 }],
      }
    }
    case 'smd': {
      const [chipLength, chipWidth] = chipSize(footprint) ?? [length ?? 2, width ?? 1.25]
      if (pinCount === 2) return endLeads(chipLength, chipWidth)
      return rowLeads(pinCount, footprintDimension(footprint, 'P') ?? 0.95, chipLength, chipWidth)
    }
    case 'to92': {
      // The legs leave the bottom of the package in a row through the centre of its round part,
      // about 0.4 of the depth behind the flat face (as in KiCad's TO-92_Inline). They leave it
      // 1.27 mm apart; a footprint's larger pitch is where formed legs land, and here every leg
      // is bent to its own island anyway.
      const leads = rowLeads(pinCount, TO92_LEG_PITCH, length ?? 4.9, width ?? 3.7)
      return { ...leads, body: { ...leads.body, y: -0.6 * leads.body.h } }
    }
    case 'to126':
      return rowLeads(pinCount, pitch, length ?? 7.6, width ?? 2.7)
    case 'trimmer': {
      const leads = rowLeads(pinCount, pitch, length ?? 9.5, width ?? 9.5)
      // A standing trimmer (3296W) has its pins underneath, along the middle of the body.
      if (length === undefined || length === width) return leads
      return { ...leads, body: { ...leads.body, y: -leads.body.h / 2 } }
    }
    case 'dip': {
      // Numbered counter-clockwise from top left, like a DIP seen from above.
      const perSide = pinCount / 2
      const top = (-(perSide - 1) * PITCH) / 2
      const left = Array.from({ length: perSide }, (_, k) => ({ x: -2.8, y: top + k * PITCH }))
      const right = Array.from({ length: perSide }, (_, k) => ({ x: 2.8, y: top + (perSide - 1 - k) * PITCH }))
      return {
        body: { x: -2.8, y: top - 1.2, w: 5.6, h: (perSide - 1) * PITCH + 2.4 },
        anchors: [...left, ...right],
        directions: [...left.map(() => ({ x: -1, y: 0 })), ...right.map(() => ({ x: 1, y: 0 }))],
      }
    }
  }
  return rowLeads(pinCount, PITCH, (pinCount - 1) * PITCH + 2.4, 2.8)
}

/**
 * Unbent lead length beyond the body. SMD parts have none and DIP legs are short. Axial parts are
 * bent to their hole spacing: "R_AXIAL-0.4" gives it in inches (0.4" = 10.16 mm), "P13.00" in mm.
 */
function defaultLeadLength(shape: Shape, footprint: string, body: Rect): number {
  if (shape === 'smd') return 0
  if (shape === 'dip') return 1
  if (shape === 'axial') {
    const inches = footprint.match(/AXIAL-?(\d+(?:\.\d+)?)/i)?.[1]
    const holeSpacing = inches ? Number(inches) * 25.4 : footprintDimension(footprint, 'P')
    if (holeSpacing) return Math.max(1, (holeSpacing - body.w) / 2)
  }
  return PITCH
}

export function componentGeometry(component: NetComponent): Geometry {
  const shape = shapeOf(component)
  const leads = leadsFor(shape, component)
  return {
    shape,
    ...leads,
    leadLength: defaultLeadLength(shape, component.footprint, leads.body),
    maxLeadLength: MAX_LEAD_LENGTH[shape],
    led: isLed(component),
  }
}

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
export function onCopper(island: Island, p: Point, isolation: number): boolean {
  return coversSquare(island.rects, p, isolation / 2)
}

/** Nearest point of the island's copper to `from`, kept a little inside it to leave room for solder. */
export function solderPoint(island: Island, from: Point, geometry: Geometry, isolation: number): Point {
  // SMD terminations sit directly on the copper; there is no lead to bend inward.
  const inset = isolation / 2 + (geometry.shape === 'smd' ? 0 : SOLDER_INSET)
  const shrunk = island.rects.map((r) => inflate(r, -Math.min(inset, r.w / 2, r.h / 2)))
  return nearestPointOnRects(shrunk, from)
}

/** World-space bounding box of the body, and optionally extra local points such as lead ends. */
export function bodyBounds(geometry: Geometry, placement: Placement, extraLocalPoints: Point[] = []): Rect {
  const { x, y, w, h } = geometry.body
  const corners = [{ x, y }, { x: x + w, y }, { x, y: y + h }, { x: x + w, y: y + h }, ...extraLocalPoints]
  return boundsOf(corners.map((p) => ({ ...toWorld(p, placement), w: 0, h: 0 })))!
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
  component: NetComponent,
  placement: Placement,
  islands: Island[],
  isolation: number,
  geometry = componentGeometry(component),
): LeadInfo[] {
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
 * In a cut-line layout the islands are not edited but follow from the cuts and from where the
 * leads end. `netlist` must be the netlist as built (footprint choices applied).
 */
export function withCutIslands(netlist: Netlist, layout: Layout): Layout {
  if (!layout.knife) return layout
  const components = new Map(netlist.components.map((c) => [c.ref, c]))
  const leadEnds = layout.placements.flatMap((placement) => {
    const component = components.get(placement.ref)
    if (!component) return []
    const defaults = defaultLeadEnds(componentGeometry(component))
    return component.pins.map((pin, k) => ({ net: pin.net, end: toWorld(placement.leads?.[pin.number] ?? defaults[k], placement) }))
  })
  const { islands, free } = islandsFromCuts(layout.knife, leadEnds)
  return { ...layout, islands, freeCopper: free }
}

/** Turns island edges into cut lines on a solid board covering the islands. */
export function toCutLayout(layout: Layout): Layout {
  const rects = layout.islands.filter((island) => !island.plane).flatMap((island) => island.rects)
  const board = boundsOf(rects) ?? { x: 0, y: 0, w: 30, h: 20 }
  return { ...layout, knife: { board, cuts: cutsFromIslands(layout.islands) } }
}

/** Back to editable islands: keeps the islands the cuts gave. */
export function fromCutLayout(layout: Layout): Layout {
  return { islands: layout.islands, placements: layout.placements }
}

/**
 * Grid placement. Islands and placements from `previous` whose net/ref still exist are kept as-is,
 * so re-importing an edited netlist does not destroy manual work.
 */
export function createLayout(netlist: Netlist, previous?: Layout): Layout {
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
  const bodies = newParts.map((c) => componentGeometry(c).body)
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
