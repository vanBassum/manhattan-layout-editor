import { rotatePoint, snapToGrid } from './geometry'
import { isRealNet, naturalCompare } from './netlist'
import { componentSymbol } from './definitions'
import type { NetComponent, NetLabel, Netlist, Point, Schematic, SchematicPlacement, Wire } from './types'

/** A pin end in schematic coordinates, with the direction a wire leaves it. */
export interface PinEnd extends Point {
  dx: number
  dy: number
}

// The schematic is the source of the connections: wires and net labels decide which pins share a
// net, and the netlist follows from them.

/** Every pin end sits on this grid (0.1 inch), as long as symbols are placed on it too. */
export const SCHEMATIC_GRID = 2.54
export const CELL_WIDTH = 10 * SCHEMATIC_GRID
export const CELL_HEIGHT = 7 * SCHEMATIC_GRID

/** A schematic with nothing left to fill in. */
export interface FullSchematic {
  /** One per component, in netlist order. */
  placements: SchematicPlacement[]
  wires: Wire[]
  labels: NetLabel[]
}

/** Map key of a point; coordinates are on the grid, so rounding only removes float noise. */
export const pointKey = (p: Point) => `${Math.round(p.x * 1000) / 1000},${Math.round(p.y * 1000) / 1000}`

/** Where a placed component's pins end, in the component's pin order, with their outward direction. */
export function pinEnds(component: NetComponent, placement: SchematicPlacement): PinEnd[] {
  // componentSymbol only returns a symbol that has every pin of the part.
  const byNumber = new Map(componentSymbol(component).pins.map((p) => [p.number, p]))
  return component.pins.map(({ number }) => {
    const pin = byNumber.get(number)!
    const at = rotatePoint(pin, placement.rotation)
    const direction = rotatePoint({ x: pin.dx, y: pin.dy }, placement.rotation)
    return { x: placement.x + at.x, y: placement.y + at.y, dx: Math.round(direction.x), dy: Math.round(direction.y) }
  })
}

/**
 * A placement for every component, in netlist order: stored ones as they are, the rest on a grid
 * below them. Placements of components no longer in the netlist are left out.
 */
function completePlacements(netlist: Netlist, schematic: Schematic | undefined): SchematicPlacement[] {
  const stored = new Map((schematic?.placements ?? []).map((p) => [p.ref, p]))
  const missing = netlist.components.filter((c) => !stored.has(c.ref))
  const columns = Math.max(1, Math.ceil(Math.sqrt(missing.length)))
  const storedYs = netlist.components.flatMap((c) => stored.get(c.ref)?.y ?? [])
  const top = storedYs.length === 0 ? 0 : Math.max(...storedYs) + CELL_HEIGHT
  const added = new Map(
    missing.map((c, i) => [
      c.ref,
      { ref: c.ref, x: (i % columns) * CELL_WIDTH, y: top + Math.floor(i / columns) * CELL_HEIGHT, rotation: 0 },
    ]),
  )
  return netlist.components.map((c) => stored.get(c.ref) ?? added.get(c.ref)!)
}

/**
 * The schematic with every component placed. Until it has labels of its own, every connected pin
 * gets a label with its net, so the schematic says exactly what the imported netlist says.
 * `built` is the netlist with footprint choices applied: a transistor's pins depend on its package.
 */
export function completeSchematic(built: Netlist, schematic: Schematic | undefined): FullSchematic {
  const placements = completePlacements(built, schematic)
  const labels =
    schematic?.labels ??
    built.components.flatMap((component, i) =>
      pinEnds(component, placements[i]).flatMap((end, k) => {
        const net = component.pins[k]?.net ?? ''
        return isRealNet(net) ? [{ x: end.x, y: end.y, name: net }] : []
      }),
    )
  return { placements, wires: schematic?.wires ?? [], labels }
}

/** True when `p` lies on the wire, ends excluded. Only straight horizontal and vertical wires take T-joins. */
function onWireInterior(p: Point, w: Wire): boolean {
  const eps = 1e-6
  if (Math.abs(w.x1 - w.x2) < eps && Math.abs(p.x - w.x1) < eps) {
    return p.y > Math.min(w.y1, w.y2) + eps && p.y < Math.max(w.y1, w.y2) - eps
  }
  if (Math.abs(w.y1 - w.y2) < eps && Math.abs(p.y - w.y1) < eps) {
    return p.x > Math.min(w.x1, w.x2) + eps && p.x < Math.max(w.x1, w.x2) - eps
  }
  return false
}

function unionFind() {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k)
    if (p === undefined || p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  return { find, union }
}

export interface SchematicNets {
  /** The imported netlist's components with the nets the schematic gives their pins. */
  netlist: Netlist
  /** Wire groups that carry two or more different labels: shorts between named nets. */
  conflicts: { names: string[]; points: Point[] }[]
  /** Points where three or more connections meet; drawn as dots. */
  junctions: Point[]
}

/**
 * Connects pins, wire ends and labels that touch, then labels with the same name. A net is named
 * after its label; an unlabelled net of two or more pins after its first pin (e.g. "R4.2"), and a
 * pin connected to nothing gets no net.
 */
export function deriveNets(netlist: Netlist, built: Netlist, schematic: FullSchematic): SchematicNets {
  const { find, union } = unionFind()
  const { wires, labels } = schematic
  const pins = built.components.flatMap((component, i) =>
    pinEnds(component, schematic.placements[i]).map((end, k) => ({ ref: component.ref, number: component.pins[k].number, end })),
  )
  const points = [
    ...pins.map((p) => p.end),
    ...labels,
    ...wires.flatMap((w) => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]),
  ]

  // How many connections meet at each point, for the junction dots.
  const degree = new Map<string, number>()
  const bump = (p: Point) => degree.set(pointKey(p), (degree.get(pointKey(p)) ?? 0) + 1)
  for (const p of pins) bump(p.end)
  for (const w of wires) {
    union(pointKey({ x: w.x1, y: w.y1 }), pointKey({ x: w.x2, y: w.y2 }))
    bump({ x: w.x1, y: w.y1 })
    bump({ x: w.x2, y: w.y2 })
  }
  const distinctPoints = new Map(points.map((p) => [pointKey(p), p]))
  for (const p of distinctPoints.values()) {
    for (const w of wires) {
      if (!onWireInterior(p, w)) continue
      union(pointKey(p), pointKey({ x: w.x1, y: w.y1 }))
      // A T-join: the wire passing through counts as two connections.
      degree.set(pointKey(p), (degree.get(pointKey(p)) ?? 0) + 2)
    }
  }

  // Before labels join groups by name: a group with two names is a short between named nets.
  const namesByGroup = new Map<string, Set<string>>()
  for (const label of labels) {
    const group = find(pointKey(label))
    namesByGroup.set(group, (namesByGroup.get(group) ?? new Set()).add(label.name))
  }
  const conflicts = [...namesByGroup.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([group, names]) => ({
      names: [...names].sort(naturalCompare),
      points: labels.filter((l) => find(pointKey(l)) === group),
    }))
  for (const label of labels) union(pointKey(label), `label:${label.name}`)

  const labelOfGroup = new Map<string, string>()
  for (const label of [...labels].sort((a, b) => naturalCompare(a.name, b.name))) {
    const group = find(pointKey(label))
    if (!labelOfGroup.has(group)) labelOfGroup.set(group, label.name)
  }
  const pinsByGroup = new Map<string, string[]>()
  for (const p of pins) {
    const group = find(pointKey(p.end))
    pinsByGroup.set(group, [...(pinsByGroup.get(group) ?? []), `${p.ref}.${p.number}`])
  }
  const netOf = (end: Point): string => {
    const group = find(pointKey(end))
    const label = labelOfGroup.get(group)
    if (label) return label
    const groupPins = pinsByGroup.get(group) ?? []
    return groupPins.length >= 2 ? [...groupPins].sort(naturalCompare)[0] : ''
  }

  let pinIndex = 0
  const components = netlist.components.map((component) => ({
    ...component,
    pins: component.pins.map((pin) => ({ ...pin, net: netOf(pins[pinIndex++].end) })),
  }))
  const nets = new Set(components.flatMap((c) => c.pins.map((p) => p.net)).filter(isRealNet))
  const junctions = [...distinctPoints.values()].filter((p) => (degree.get(pointKey(p)) ?? 0) >= 3)
  return { netlist: { components, nets: [...nets].sort(naturalCompare) }, conflicts, junctions }
}

/**
 * The schematic with some parts moved or rotated. Wire ends and labels on their pins go along, so
 * the connections stay; a wire can end up diagonal and then needs tidying by hand.
 */
export function withPlacementChanges(schematic: FullSchematic, built: Netlist, changed: SchematicPlacement[]): FullSchematic {
  const components = new Map(built.components.map((c) => [c.ref, c]))
  const oldPlacements = new Map(schematic.placements.map((p) => [p.ref, p]))
  const moves = new Map<string, Point>()
  for (const placement of changed) {
    const component = components.get(placement.ref)
    const old = oldPlacements.get(placement.ref)
    if (!component || !old) continue
    const newEnds = pinEnds(component, placement)
    pinEnds(component, old).forEach((end, k) => moves.set(pointKey(end), newEnds[k]))
  }
  const moved = (p: Point) => moves.get(pointKey(p)) ?? p
  const byRef = new Map(changed.map((p) => [p.ref, p]))
  return {
    placements: schematic.placements.map((p) => byRef.get(p.ref) ?? p),
    wires: schematic.wires.map((w) => {
      const a = moved({ x: w.x1, y: w.y1 })
      const b = moved({ x: w.x2, y: w.y2 })
      return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    }),
    labels: schematic.labels.map((l) => ({ ...l, ...moved(l) })),
  }
}

/** An agent's placements, checked and snapped to the grid, rotation in quarter turns. */
export function agentPlacements(netlist: Netlist, placements: unknown): SchematicPlacement[] {
  if (!Array.isArray(placements)) throw new Error('"placements" must be an array')
  const refs = new Set(netlist.components.map((c) => c.ref))
  const updates = new Map<string, SchematicPlacement>()
  for (const item of placements as Partial<SchematicPlacement>[]) {
    const { ref, x, y, rotation = 0 } = item
    if (typeof ref !== 'string' || !refs.has(ref)) throw new Error(`Unknown component "${String(ref)}"`)
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error(`${ref}: x and y must be numbers`)
    if (rotation % 90 !== 0) throw new Error(`${ref}: rotation must be a multiple of 90`)
    updates.set(ref, { ref, x: snapToGrid(x, SCHEMATIC_GRID), y: snapToGrid(y, SCHEMATIC_GRID), rotation: ((rotation % 360) + 360) % 360 })
  }
  return [...updates.values()]
}

const gridPoint = (value: unknown, what: string): Point => {
  if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
    throw new Error(`${what} must be [x, y] in mm`)
  }
  return { x: snapToGrid(value[0], SCHEMATIC_GRID), y: snapToGrid(value[1], SCHEMATIC_GRID) }
}

/** Wires from an agent's polylines ([[x, y], ...] each), snapped to the grid. Diagonal steps are refused. */
export function wiresFromPolylines(polylines: unknown): Wire[] {
  if (!Array.isArray(polylines)) throw new Error('"wires" must be an array of polylines')
  return polylines.flatMap((line, i) => {
    if (!Array.isArray(line) || line.length < 2) throw new Error(`wires[${i}] needs at least two points`)
    const points = line.map((p, k) => gridPoint(p, `wires[${i}][${k}]`))
    return points.slice(1).flatMap((b, k) => {
      const a = points[k]
      if (a.x !== b.x && a.y !== b.y) throw new Error(`wires[${i}] step ${k} is diagonal; use horizontal and vertical steps`)
      return a.x === b.x && a.y === b.y ? [] : [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }]
    })
  })
}

/** Labels from an agent's {x, y, name} list, snapped to the grid. */
export function labelsFromAgent(labels: unknown): NetLabel[] {
  if (!Array.isArray(labels)) throw new Error('"labels" must be an array')
  return labels.map((item: { x?: unknown; y?: unknown; name?: unknown }, i) => {
    if (typeof item.name !== 'string' || item.name.trim() === '') throw new Error(`labels[${i}] needs a name`)
    const at = gridPoint([item.x, item.y], `labels[${i}]`)
    return { ...at, name: item.name.trim() }
  })
}

/** Pins ("R1.2") whose net differs between two netlists of the same components, e.g. the PCB's and the schematic's. */
export function pinsWithOtherNet(a: Netlist, b: Netlist): string[] {
  const netsOfB = new Map<string, string>(b.components.flatMap((c) => c.pins.map((p) => [`${c.ref}.${p.number}`, p.net])))
  return a.components.flatMap((c) =>
    c.pins.flatMap((p) => {
      const pin = `${c.ref}.${p.number}`
      return netsOfB.get(pin) === p.net ? [] : [pin]
    }),
  )
}
