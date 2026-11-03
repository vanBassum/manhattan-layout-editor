import { buildNetlist, buildProjectNetlist } from './definitions'
import { boundsOf, inflate, rectContains, rectsOverlap, rotatePoint, samePoint, snapToGrid } from './geometry'
import { followNetlist } from './layout'
import { isRealNet, naturalCompare } from './netlist'
import { NO_WIRING, selectedRefs, selectedWiring } from './selection'
import type {
  BuiltComponent,
  BuiltNetlist,
  LabelSymbol,
  NetLabel,
  Netlist,
  PinEnd,
  Point,
  Project,
  Rect,
  Schematic,
  SchematicPlacement,
  Selection,
  Wire,
  WiringSelection,
} from './types'

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

/**
 * The value rounded to a millionth of a mm. Sums like 10.16 + 12.7 give 22.860000000000003; a wire
 * end with that noise is no longer exactly in line with one at 22.86, and stops being straight.
 */
const withoutFloatNoise = (v: number) => Math.round(v * 1e6) / 1e6

export const wireEnds = (w: Wire): [Point, Point] => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]
const isHorizontal = (w: Wire) => w.y1 === w.y2 && w.x1 !== w.x2
const isVertical = (w: Wire) => w.x1 === w.x2 && w.y1 !== w.y2

/** A point of the symbol, relative to the placement's origin: mirrored first, then rotated. */
function placedOffset(p: Point, placement: SchematicPlacement): Point {
  return rotatePoint(placement.mirrored ? { x: -p.x, y: p.y } : p, placement.rotation)
}

/**
 * The placement flipped on screen, around its origin. A horizontal flip turns the rotation the other
 * way; a vertical flip is a horizontal one plus half a turn.
 */
export function flipped(placement: SchematicPlacement, axis: 'horizontal' | 'vertical'): SchematicPlacement {
  const { mirrored, ...rest } = placement
  const turn = axis === 'horizontal' ? 360 : 540
  const rotation = (turn - placement.rotation) % 360
  return mirrored ? { ...rest, rotation } : { ...rest, rotation, mirrored: true }
}

/** Where a placed component's pins end in the schematic, in the component's pin order, with their outward direction. */
export function pinEnds(component: BuiltComponent, placement: SchematicPlacement): PinEnd[] {
  // A built part's symbol has every pin of the part.
  const byNumber = new Map(component.symbol.pins.map((p) => [p.number, p]))
  return component.pins.map(({ number }) => {
    const pin = byNumber.get(number)!
    const at = placedOffset(pin, placement)
    const direction = placedOffset({ x: pin.dx, y: pin.dy }, placement)
    return { x: withoutFloatNoise(placement.x + at.x), y: withoutFloatNoise(placement.y + at.y), dx: Math.round(direction.x), dy: Math.round(direction.y) }
  })
}

/** A placed part with where its pins end. */
export interface PlacedPart {
  component: BuiltComponent
  placement: SchematicPlacement
  pins: PinEnd[]
}

/** The placements that `built` has a component for, with their pin ends. */
export function placedParts(placements: SchematicPlacement[], built: BuiltNetlist): PlacedPart[] {
  const componentsByRef = new Map(built.components.map((c) => [c.ref, c]))
  return placements.flatMap((placement) => {
    const component = componentsByRef.get(placement.ref)
    return component ? [{ component, placement, pins: pinEnds(component, placement) }] : []
  })
}

/** Map keys of every pin end of `parts`. */
export const pinKeysOf = (parts: PlacedPart[]): Set<string> => new Set(parts.flatMap(({ pins }) => pins.map(pointKey)))

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
export function completeSchematic(built: BuiltNetlist, schematic: Schematic | undefined): FullSchematic {
  const placements = completePlacements(built, schematic)
  const labels =
    schematic?.labels ??
    placedParts(placements, built).flatMap(({ component, pins }) =>
      pins.flatMap((end, k) => {
        const { net } = component.pins[k]
        return isRealNet(net) ? [{ x: end.x, y: end.y, name: net }] : []
      }),
    )
  return { placements, wires: schematic?.wires ?? [], labels }
}

const isGroundName = (name: string) => /^(GND|AGND|DGND|PGND|VSS|0)$/i.test(name)
const isPowerName = (name: string) => /^(V\+|V-|VCC|VDD|VEE|[+-]?\d+(\.\d+)?V)$/i.test(name)

/** How a label is drawn; labels from before it was stored get the symbol their name suggests. */
export function labelSymbol(label: NetLabel): LabelSymbol {
  if (label.symbol) return label.symbol
  if (isGroundName(label.name)) return 'ground'
  return isPowerName(label.name) ? 'power' : 'net'
}

/** True when `p` lies on the wire, ends excluded. Only straight horizontal and vertical wires take T-joins. */
export function onWireInterior(p: Point, w: Wire): boolean {
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
 * pin connected to nothing gets no net. Every pin of `netlist` must be among the placed `parts`.
 */
export function deriveNets(netlist: Netlist, parts: PlacedPart[], wiring: Pick<FullSchematic, 'wires' | 'labels'>): SchematicNets {
  const { find, union } = unionFind()
  const { wires, labels } = wiring
  const pins = parts.flatMap(({ component, pins: ends }) =>
    ends.map((end, k) => ({ ref: component.ref, number: component.pins[k].number, end })),
  )
  const points = [
    ...pins.map((p) => p.end),
    ...labels,
    ...wires.flatMap(wireEnds),
  ]

  // How many connections meet at each point, for the junction dots.
  const degree = new Map<string, number>()
  const bump = (p: Point) => degree.set(pointKey(p), (degree.get(pointKey(p)) ?? 0) + 1)
  for (const p of pins) bump(p.end)
  for (const w of wires) {
    const [a, b] = wireEnds(w)
    union(pointKey(a), pointKey(b))
    bump(a)
    bump(b)
  }
  const distinctPoints = new Map(points.map((p) => [pointKey(p), p]))
  for (const p of distinctPoints.values()) {
    for (const w of wires) {
      if (!onWireInterior(p, w)) continue
      union(pointKey(p), pointKey(wireEnds(w)[0]))
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

  const endsByPin = new Map(pins.map((p) => [`${p.ref}.${p.number}`, p.end]))
  const netOfPin = (ref: string, number: string): string => {
    const end = endsByPin.get(`${ref}.${number}`)
    if (!end) throw new Error(`${ref}.${number} is not placed in the schematic`)
    return netOf(end)
  }
  const components = netlist.components.map((component) => ({
    ...component,
    pins: component.pins.map((pin) => ({ ...pin, net: netOfPin(component.ref, pin.number) })),
  }))
  const nets = new Set(components.flatMap((c) => c.pins.map((p) => p.net)).filter(isRealNet))
  const junctions = [...distinctPoints.values()].filter((p) => (degree.get(pointKey(p)) ?? 0) >= 3)
  return { netlist: { components, nets: [...nets].sort(naturalCompare) }, conflicts, junctions }
}

/**
 * A straight wire from `fixed` to `moved` after its other end moved off-line: a Z that jogs one grid
 * step before the moved end, and never before `attached` (points joined to the wire's middle, such
 * as labels and T-joins). The wire keeps lying where it was for as long as possible, so those stay
 * connected, and it still enters the moved pin in its own direction.
 */
function rubberBand(fixed: Point, moved: Point, horizontal: boolean, attached: Point[] = []): Wire[] {
  const along = (p: Point) => (horizontal ? p.x : p.y)
  const direction = Math.sign(along(moved) - along(fixed))
  // Too short to step back from the moved end: jog right at the fixed end instead (an L).
  const preferred = Math.abs(along(fixed) - along(moved)) > SCHEMATIC_GRID ? along(moved) - direction * SCHEMATIC_GRID : along(fixed)
  const jog = attached.map(along).reduce((j, a) => (direction * (a - j) > 0 ? a : j), preferred)
  const corners = horizontal
    ? [{ x: jog, y: fixed.y }, { x: jog, y: moved.y }]
    : [{ x: fixed.x, y: jog }, { x: moved.x, y: jog }]
  return polylineWires([fixed, ...corners, moved])
}

/** What a move or drag changes: parts to their new placement, and the selected wiring by `delta`. */
export interface SchematicMove {
  /** Moved or rotated parts in their new placement; each pin goes from where it was to where it is now. */
  placements: SchematicPlacement[]
  wiring: WiringSelection
  delta: Point
  /**
   * Drag (true): wiring outside the selection keeps every connection; wires attached to what moves
   * stretch, staying horizontal and vertical, and where something moves away from a pin or the
   * middle of a wire that stays put, a short wire bridges the gap. Move (false): only the selection
   * moves, and connections across its edge break.
   */
  keepConnections: boolean
}

const straight = (a: Point, b: Point) => a.x === b.x || a.y === b.y
const wireBetween = (a: Point, b: Point): Wire => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })

const shifted = (p: Point, delta: Point): Point => ({ x: withoutFloatNoise(p.x + delta.x), y: withoutFloatNoise(p.y + delta.y) })

/** A point that moves, by the key of where it was. */
type PointMoves = Map<string, { from: Point; to: Point }>

/** Where a point of the unselected wiring goes, or undefined when it stays where it is. */
type Follow = (p: Point) => Point | undefined

/** Every point that `move` moves, from where it was to where it goes. Pins win over wiring on the same spot. */
function movingPoints(schematic: FullSchematic, parts: PlacedPart[], move: SchematicMove): PointMoves {
  const { wiring, delta } = move
  const moves: PointMoves = new Map()
  const movingWires = schematic.wires.filter((_, i) => wiring.wires.includes(i))
  for (const p of [...movingWires.flatMap(wireEnds), ...wiring.points]) moves.set(pointKey(p), { from: p, to: shifted(p, delta) })
  const partsByRef = new Map(parts.map((part) => [part.placement.ref, part]))
  for (const placement of move.placements) {
    const part = partsByRef.get(placement.ref)
    if (!part) continue
    const newEnds = pinEnds(part.component, placement)
    part.pins.forEach((end, k) => moves.set(pointKey(end), { from: end, to: newEnds[k] }))
  }
  return moves
}

/**
 * Where a point of the unselected wiring goes when it is attached to something that moves: a moving
 * point, the middle of a selected wire, or the middle of an unselected wire whose two ends are carried
 * by the same shift. Such a wire moves as a whole, so whatever is joined to its middle (a T-join, a
 * label) goes along too.
 */
function follower(schematic: FullSchematic, selectedWires: ReadonlySet<number>, moves: PointMoves, delta: Point): Follow {
  const movingWires = schematic.wires.filter((_, i) => selectedWires.has(i))
  const attachedTo = (p: Point): Point | undefined =>
    moves.get(pointKey(p))?.to ?? (movingWires.some((w) => onWireInterior(p, w)) ? shifted(p, delta) : undefined)
  const carried = schematic.wires.flatMap((w, i) => {
    if (selectedWires.has(i)) return []
    const [a, b] = wireEnds(w)
    const [a2, b2] = [attachedTo(a), attachedTo(b)]
    if (!a2 || !b2) return []
    const d = { x: a2.x - a.x, y: a2.y - a.y }
    return samePoint(d, { x: b2.x - b.x, y: b2.y - b.y }) ? [{ wire: w, d }] : []
  })
  return (p) => {
    const direct = attachedTo(p)
    if (direct) return direct
    const host = carried.find(({ wire }) => onWireInterior(p, wire))
    return host && shifted(p, host.d)
  }
}

/**
 * Every wire after the move, at its own index, followed by the pieces that bends add. Selected wires
 * shift by `delta`. With `follow` (a drag), unselected wires attached to what moves stretch along,
 * staying horizontal and vertical; without it (a move), they stay where they are.
 */
function stretchedWires(schematic: FullSchematic, parts: PlacedPart[], selectedWires: ReadonlySet<number>, delta: Point, follow?: Follow): Wire[] {
  // Things that can sit on the middle of a wire and must stay connected to it when it bends.
  const attachmentPoints = [...schematic.labels, ...schematic.wires.flatMap(wireEnds), ...parts.flatMap(({ pins }) => pins)]
  const inPlace: Wire[] = []
  const added: Wire[] = []
  const emit = (segments: Wire[], fallback: Wire) => {
    inPlace.push(segments[0] ?? fallback)
    added.push(...segments.slice(1))
  }
  schematic.wires.forEach((w, i) => {
    const [a, b] = wireEnds(w)
    if (selectedWires.has(i)) return inPlace.push(wireBetween(shifted(a, delta), shifted(b, delta)))
    if (!follow) return inPlace.push(w)
    const [a2, b2] = [follow(a), follow(b)]
    if (!a2 && !b2) return inPlace.push(w)
    const [from, to] = [a2 ?? a, b2 ?? b]
    if (straight(from, to)) return inPlace.push(wireBetween(from, to))
    const oneEndMoved = !a2 || !b2
    if (oneEndMoved && (isHorizontal(w) || isVertical(w))) {
      const attached = attachmentPoints.filter((p) => onWireInterior(p, w) && !follow(p))
      return emit(a2 ? rubberBand(b, a2, isHorizontal(w), attached) : rubberBand(a, b2!, isHorizontal(w), attached), wireBetween(from, to))
    }
    emit(polylineWires(route(from, to, isHorizontal(w))), wireBetween(from, to))
  })
  return [...inPlace, ...added]
}

/**
 * Wires that bridge the gap where something moves away from what stays put and cannot stretch
 * along: a pin of a part that does not move (`fixedPins`), or the middle of a wire that stays.
 */
function bridgingWires(schematic: FullSchematic, fixedPins: ReadonlySet<string>, selectedWires: ReadonlySet<number>, moves: PointMoves, follow: Follow): Wire[] {
  const staysPut = (p: Point) =>
    fixedPins.has(pointKey(p)) ||
    schematic.wires.some((w, i) => !selectedWires.has(i) && onWireInterior(p, w) && !wireEnds(w).every((end) => follow(end)))
  return [...moves.values()].flatMap(({ from, to }) => (!samePoint(from, to) && staysPut(from) ? polylineWires(route(from, to, true)) : []))
}

/**
 * The schematic after a move or drag. Every wire stays at its index, so a selection of wires still
 * names the same wires; wires that a drag adds (bends, bridges) come after them.
 */
export function withSchematicMoved(schematic: FullSchematic, built: BuiltNetlist, move: SchematicMove): FullSchematic {
  const { wiring, delta, keepConnections } = move
  const parts = placedParts(schematic.placements, built)
  const selectedWires = new Set(wiring.wires)
  const moves = movingPoints(schematic, parts, move)
  const follow = keepConnections ? follower(schematic, selectedWires, moves, delta) : undefined
  const changedRefs = new Set(move.placements.map((p) => p.ref))
  const fixedPins = pinKeysOf(parts.filter(({ placement }) => !changedRefs.has(placement.ref)))
  const bridges = follow ? bridgingWires(schematic, fixedPins, selectedWires, moves, follow) : []

  const byRef = new Map(move.placements.map((p) => [p.ref, p]))
  const selectedLabels = new Set(wiring.labels)
  return {
    placements: schematic.placements.map((p) => byRef.get(p.ref) ?? p),
    wires: [...stretchedWires(schematic, parts, selectedWires, delta, follow), ...bridges],
    labels: schematic.labels.map((l, i) => {
      if (selectedLabels.has(i)) return { ...l, ...shifted(l, delta) }
      const to = follow?.(l)
      // Only the position: a point that follows a pin is that pin's end, which also carries its direction.
      return to ? { ...l, x: to.x, y: to.y } : l
    }),
  }
}

/**
 * The schematic with some parts moved or rotated, dragging the wiring along: wire ends and labels on
 * their pins go with them and wires stay horizontal and vertical.
 */
export function withPlacementChanges(schematic: FullSchematic, built: BuiltNetlist, changed: SchematicPlacement[]): FullSchematic {
  return withSchematicMoved(schematic, built, { placements: changed, wiring: NO_WIRING, delta: { x: 0, y: 0 }, keepConnections: true })
}

/**
 * The schematic with parts `refs` changed by `turnPart` and the rotation of labels `labelIndexes`
 * by `turnLabel`; wires and labels on the parts' pins go along.
 */
function withTurned(
  schematic: FullSchematic,
  built: BuiltNetlist,
  refs: string[],
  labelIndexes: number[],
  turnPart: (p: SchematicPlacement) => SchematicPlacement,
  turnLabel: (rotation: number) => number,
): FullSchematic {
  const turnedParts = schematic.placements.filter((p) => refs.includes(p.ref)).map(turnPart)
  const next = withPlacementChanges(schematic, built, turnedParts)
  const labels = next.labels.map((l, i) => (labelIndexes.includes(i) ? { ...l, rotation: turnLabel(l.rotation ?? 0) } : l))
  return { ...next, labels }
}

/** Parts `refs` and labels `labelIndexes` each turned in place, clockwise by `degrees`. */
export function rotatedSelection(schematic: FullSchematic, built: BuiltNetlist, refs: string[], labelIndexes: number[], degrees: number): FullSchematic {
  // Symbols only turn in quarter turns, so their pins stay on the grid.
  const quarterTurns = Math.max(1, Math.round(degrees / 90)) * 90
  return withTurned(
    schematic,
    built,
    refs,
    labelIndexes,
    (p) => ({ ...p, rotation: (p.rotation + quarterTurns) % 360 }),
    (rotation) => (rotation + quarterTurns) % 360,
  )
}

/** Parts `refs` and labels `labelIndexes` each mirrored in place. */
export function flippedSelection(
  schematic: FullSchematic,
  built: BuiltNetlist,
  refs: string[],
  labelIndexes: number[],
  axis: 'horizontal' | 'vertical',
): FullSchematic {
  // A ground or power symbol is symmetric, so mirroring it only changes which way it points.
  const turn = axis === 'horizontal' ? 360 : 540
  return withTurned(schematic, built, refs, labelIndexes, (p) => flipped(p, axis), (rotation) => (turn - rotation) % 360)
}

/** The schematic with label `index` changed. */
export function withLabelChanged(schematic: FullSchematic, index: number, changes: Partial<NetLabel>): FullSchematic {
  return { ...schematic, labels: schematic.labels.map((l, i) => (i === index ? { ...l, ...changes } : l)) }
}

/** A wire after tidying, with the indices of the wires it came from. */
interface TidyWire {
  wire: Wire
  sources: number[]
}

/** The line a horizontal or vertical wire lies on, and the stretch of that line it covers. */
function wireLine(w: Wire): { key: string; from: number; to: number } | undefined {
  if (isHorizontal(w)) return { key: `h${pointKey({ x: 0, y: w.y1 })}`, from: Math.min(w.x1, w.x2), to: Math.max(w.x1, w.x2) }
  if (isVertical(w)) return { key: `v${pointKey({ x: w.x1, y: 0 })}`, from: Math.min(w.y1, w.y2), to: Math.max(w.y1, w.y2) }
  return undefined
}

/**
 * Wires that lie over each other on one line, split at all their ends into pieces that do not
 * overlap. Otherwise the end of one in the middle of the other reads as a junction.
 */
function withoutOverlaps(wires: Wire[]): TidyWire[] {
  const byLine = new Map<string, number[]>()
  wires.forEach((w, i) => {
    const line = wireLine(w)
    if (line) byLine.set(line.key, [...(byLine.get(line.key) ?? []), i])
  })
  const result: TidyWire[] = []
  wires.forEach((w, i) => {
    const line = wireLine(w)
    if (!line) return result.push({ wire: w, sources: [i] })
    const onLine = byLine.get(line.key)!
    // The whole line is split when its first wire comes along.
    if (onLine[0] !== i) return
    const spans = onLine.map((k) => ({ k, ...wireLine(wires[k])! }))
    const stops = [...new Set(spans.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b)
    for (let n = 0; n + 1 < stops.length; n++) {
      const [from, to] = [stops[n], stops[n + 1]]
      const sources = spans.filter((s) => s.from <= from && to <= s.to).map((s) => s.k)
      if (sources.length === 0) continue
      const whole = spans.find((s) => s.from === from && s.to === to)
      if (sources.length === 1 && whole) {
        result.push({ wire: wires[whole.k], sources })
        continue
      }
      const wire = isHorizontal(w) ? { x1: from, y1: w.y1, x2: to, y2: w.y1 } : { x1: w.x1, y1: from, x2: w.x1, y2: to }
      result.push({ wire, sources })
    }
  })
  return result
}

/** Wire ends that connect to nothing: no other wire, pin or label there. */
function looseEnds(wires: Wire[], connectionPoints: Set<string>): Point[] {
  const endCount = new Map<string, number>()
  for (const p of wires.flatMap(wireEnds)) endCount.set(pointKey(p), (endCount.get(pointKey(p)) ?? 0) + 1)
  return wires
    .flatMap(wireEnds)
    .filter((p) => endCount.get(pointKey(p)) === 1 && !connectionPoints.has(pointKey(p)) && !wires.some((w) => onWireInterior(p, w)))
}

/** Pin ends and labels: what a wire end can connect to besides other wires. */
function connectionPoints(schematic: FullSchematic, built: BuiltNetlist): Set<string> {
  const pins = placedParts(schematic.placements, built).flatMap((part) => part.pins)
  return new Set([...pins, ...schematic.labels].map(pointKey))
}

/** The schematic's wire ends that connect to nothing. */
export function looseWireEnds(schematic: FullSchematic, built: BuiltNetlist): Point[] {
  return looseEnds(schematic.wires, connectionPoints(schematic, built))
}

/**
 * The schematic with its wires tidied after a drag, with the selected wire indices renumbered to
 * match. Ends lose float noise; zero-length wires and duplicates go; wires lying over each other
 * become pieces that do not overlap. With `allowedLooseEnds`, wires that end loose anywhere else go
 * too, repeatedly: a drag that keeps connections leaves such ends only where a wire folded back on
 * itself or was left behind.
 */
export function withTidyWires(
  schematic: FullSchematic,
  built: BuiltNetlist,
  selectedWires: number[],
  allowedLooseEnds?: Point[],
): { schematic: FullSchematic; selectedWires: number[]; changed: boolean } {
  const rounded = schematic.wires.map((w) => ({
    x1: withoutFloatNoise(w.x1),
    y1: withoutFloatNoise(w.y1),
    x2: withoutFloatNoise(w.x2),
    y2: withoutFloatNoise(w.y2),
  }))
  let tidy = withoutOverlaps(rounded).filter(({ wire }) => !samePoint(...wireEnds(wire)))
  if (allowedLooseEnds) {
    const connections = connectionPoints(schematic, built)
    for (const p of allowedLooseEnds) connections.add(pointKey(p))
    for (;;) {
      const loose = new Set(looseEnds(tidy.map((t) => t.wire), connections).map(pointKey))
      const kept = tidy.filter(({ wire }) => !wireEnds(wire).some((p) => loose.has(pointKey(p))))
      if (kept.length === tidy.length) break
      tidy = kept
    }
  }
  const wires = tidy.map((t) => t.wire)
  const changed = wires.length !== schematic.wires.length || wires.some((w, i) => !sameWire(w, schematic.wires[i]))
  const selected = new Set(selectedWires)
  const renumbered = tidy.flatMap((t, i) => (t.sources.some((k) => selected.has(k)) ? [i] : []))
  return { schematic: { ...schematic, wires }, selectedWires: renumbered, changed }
}

const sameWire = (a: Wire, b: Wire) => a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2

/** An agent's placements, checked and snapped to the grid, rotation in quarter turns. */
export function agentPlacements(netlist: Netlist, placements: unknown): SchematicPlacement[] {
  if (!Array.isArray(placements)) throw new Error('"placements" must be an array')
  const refs = new Set(netlist.components.map((c) => c.ref))
  const updates = new Map<string, SchematicPlacement>()
  for (const item of placements as Partial<SchematicPlacement>[]) {
    const { ref, x, y, rotation = 0, mirrored = false } = item
    if (typeof ref !== 'string' || !refs.has(ref)) throw new Error(`Unknown component "${String(ref)}"`)
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error(`${ref}: x and y must be numbers`)
    if (rotation % 90 !== 0) throw new Error(`${ref}: rotation must be a multiple of 90`)
    if (typeof mirrored !== 'boolean') throw new Error(`${ref}: mirrored must be true or false`)
    const placement = { ref, x: snapToGrid(x, SCHEMATIC_GRID), y: snapToGrid(y, SCHEMATIC_GRID), rotation: ((rotation % 360) + 360) % 360 }
    updates.set(ref, mirrored ? { ...placement, mirrored } : placement)
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
  return labels.map((item: { x?: unknown; y?: unknown; name?: unknown; symbol?: unknown; rotation?: unknown }, i) => {
    if (typeof item.name !== 'string' || item.name.trim() === '') throw new Error(`labels[${i}] needs a name`)
    const at = gridPoint([item.x, item.y], `labels[${i}]`)
    const label: NetLabel = { ...at, name: item.name.trim() }
    if (item.symbol !== undefined) {
      if (item.symbol !== 'net' && item.symbol !== 'ground' && item.symbol !== 'power' && item.symbol !== 'terminal') {
        throw new Error(`labels[${i}].symbol must be "net", "ground", "power" or "terminal"`)
      }
      label.symbol = item.symbol
    }
    if (item.rotation !== undefined) {
      if (typeof item.rotation !== 'number' || item.rotation % 90 !== 0) throw new Error(`labels[${i}].rotation must be a multiple of 90`)
      label.rotation = ((item.rotation % 360) + 360) % 360
    }
    return label
  })
}

/** The project's schematic with every part placed. */
export const projectSchematic = (project: Project): FullSchematic => completeSchematic(buildProjectNetlist(project), project.schematic)

/** The nets the project's schematic gives, which the PCB does not use until it is updated. */
export function projectSchematicNets(project: Project): SchematicNets {
  const built = buildProjectNetlist(project)
  const schematic = completeSchematic(built, project.schematic)
  return deriveNets(project.netlist, placedParts(schematic.placements, built), schematic)
}

/** The project with the PCB brought in line with the schematic: its nets, and islands that follow them. */
export function withSchematicNets(project: Project): Project {
  const { netlist } = projectSchematicNets(project)
  const built = buildNetlist(netlist, project.layout.placements, project.definitions)
  return { ...project, netlist, layout: followNetlist(project.layout, project.netlist, built) }
}

/** For every pin ("R1.2") that shares a net with other pins, all pins on that net as one key. */
function netMatesByPin(netlist: Netlist): Map<string, string> {
  const pinsByNet = new Map<string, string[]>()
  for (const c of netlist.components) {
    for (const p of c.pins) {
      if (isRealNet(p.net)) pinsByNet.set(p.net, [...(pinsByNet.get(p.net) ?? []), `${c.ref}.${p.number}`])
    }
  }
  const mates = new Map<string, string>()
  for (const pins of pinsByNet.values()) {
    // A net with one pin connects that pin to nothing, the same as no net.
    if (pins.length < 2) continue
    const key = [...pins].sort(naturalCompare).join(' ')
    for (const pin of pins) mates.set(pin, key)
  }
  return mates
}

/**
 * Pins ("R1.2") connected to other pins in one netlist than in the other, e.g. the PCB's and the
 * schematic's. Only the connections count: a net that is merely named differently is no change.
 */
export function pinsWithOtherNet(a: Netlist, b: Netlist): string[] {
  const [matesInA, matesInB] = [netMatesByPin(a), netMatesByPin(b)]
  return a.components.flatMap((c) =>
    c.pins.flatMap((p) => {
      const pin = `${c.ref}.${p.number}`
      return (matesInA.get(pin) ?? '') === (matesInB.get(pin) ?? '') ? [] : [pin]
    }),
  )
}

/** Pins ("R1.2") on no net at all. */
export const unconnectedPins = (netlist: Netlist): string[] =>
  netlist.components.flatMap((c) => c.pins.filter((p) => !p.net).map((p) => `${c.ref}.${p.number}`))

// ---------- Wire editing ----------
// Every way of drawing or changing wires goes through these few functions, so they all behave alike.

/** From a to b along the grid: straight when they line up, else an L whose first leg is horizontal when `horizontalFirst`. */
export function route(a: Point, b: Point, horizontalFirst: boolean): Point[] {
  if (a.x === b.x || a.y === b.y) return [a, b]
  return [a, horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y }, b]
}

/** One wire per step of a polyline; steps of zero length are left out. */
export function polylineWires(points: Point[]): Wire[] {
  return points.slice(1).flatMap((b, k) => {
    const a = points[k]
    return samePoint(a, b) ? [] : [{ x1: a.x, y1: a.y, x2: b.x, y2: b.y }]
  })
}

/** True when a wire ending at `p` connects to something: a pin end, a wire end, or the middle of a wire (a T-join). */
export function isConnection(p: Point, wires: Wire[], pinKeys: ReadonlySet<string>): boolean {
  return pinKeys.has(pointKey(p)) || wires.some((w) => wireEnds(w).some((e) => samePoint(e, p)) || onWireInterior(p, w))
}

// ---------- Pointing at the schematic ----------
// What a press, a drag or a selection rectangle hits and does. Only how far a grab reaches depends
// on the zoom, so the view passes it in.

/** A pin end or wire end under the pointer. */
export interface Grab {
  point: Point
  onPin: boolean
}

/** The nearest pin end or wire end within `radius` of `p`; a pin wins over a wire end on the same spot. */
export function grabAt(wires: Wire[], parts: PlacedPart[], p: Point, radius: number): Grab | null {
  const pinKeys = pinKeysOf(parts)
  const candidates: Grab[] = [
    ...parts.flatMap(({ pins }) => pins.map((pin) => ({ point: { x: pin.x, y: pin.y }, onPin: true }))),
    ...wires.flatMap(wireEnds).map((end) => ({ point: end, onPin: pinKeys.has(pointKey(end)) })),
  ]
  let best: Grab | null = null
  let bestDistance = radius
  for (const c of candidates) {
    const d = Math.hypot(c.point.x - p.x, c.point.y - p.y)
    if (d < bestDistance - 1e-9 || (best && d <= bestDistance + 1e-9 && c.onPin && !best.onPin)) [best, bestDistance] = [c, d]
  }
  return best
}

/** Where a part can be grabbed, and what a selection rectangle must touch: its pin ends with some margin. */
function partArea(pins: PinEnd[]): Rect | null {
  const bounds = boundsOf(pins.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))
  return bounds && inflate(bounds, 2)
}

const rectInside = (inner: Rect, outer: Rect) =>
  rectContains(outer, inner) && rectContains(outer, { x: inner.x + inner.w, y: inner.y + inner.h })

/** True when the wire touches the rectangle; wires are horizontal or vertical, so their bounding box will do. */
const wireTouches = (w: Wire, r: Rect) =>
  Math.max(w.x1, w.x2) >= r.x && Math.min(w.x1, w.x2) <= r.x + r.w && Math.max(w.y1, w.y2) >= r.y && Math.min(w.y1, w.y2) <= r.y + r.h

/**
 * What a selection rectangle selects: what lies entirely inside `area`, or with `crossing`, whatever
 * it touches. Either way, wire ends inside it are selected as points, so a wire reaching out of it
 * stretches when the selection is dragged; ends on a pin follow that pin instead.
 */
export function marqueeSelection(
  schematic: FullSchematic,
  parts: PlacedPart[],
  area: Rect,
  crossing: boolean,
): { refs: string[]; wiring: WiringSelection } {
  const refs = parts
    .filter(({ pins }) => {
      const partBounds = partArea(pins)
      return partBounds !== null && (crossing ? rectsOverlap(partBounds, area) : rectInside(partBounds, area))
    })
    .map(({ placement }) => placement.ref)
  const pinKeys = pinKeysOf(parts)
  const ends = new Map(
    schematic.wires
      .flatMap(wireEnds)
      .filter((p) => rectContains(area, p) && !pinKeys.has(pointKey(p)))
      .map((p) => [pointKey(p), p]),
  )
  const wiring: WiringSelection = {
    wires: schematic.wires.flatMap((w, i) => {
      const inside = wireEnds(w).every((end) => rectContains(area, end))
      return inside || (crossing && wireTouches(w, area)) ? [i] : []
    }),
    labels: schematic.labels.flatMap((l, i) => (rectContains(area, l) ? [i] : [])),
    points: [...ends.values()],
  }
  return { refs, wiring }
}

/** A point on the schematic grid. */
export const snapPoint = (p: Point): Point => ({ x: snapToGrid(p.x, SCHEMATIC_GRID), y: snapToGrid(p.y, SCHEMATIC_GRID) })

/**
 * The selection `moving` being dragged over `base`, the schematic as it was when the drag started.
 * `keepConnections`: drag (the wiring around it stretches along) or move (only the selection moves).
 */
export interface SchematicDrag {
  moving: Selection
  base: FullSchematic
  keepConnections: boolean
}

/**
 * The pointer movement `d` as the drag applies it. Dragging one wire on its own shifts it sideways
 * only: sliding it along itself would just bend the wires at its ends. Everything else follows the pointer.
 */
export function alongDragAxis(drag: SchematicDrag, d: Point): Point {
  const moving = selectedWiring(drag.moving)
  const loneWire = drag.keepConnections && selectedRefs(drag.moving).length === 0 && moving.wires.length === 1 && moving.labels.length === 0
  const w = loneWire ? drag.base.wires[moving.wires[0]] : undefined
  if (!w || moving.points.length > 0) return d
  if (w.y1 === w.y2) return { x: 0, y: d.y }
  if (w.x1 === w.x2) return { x: d.x, y: 0 }
  return d
}

/**
 * The drag's base with its selection shifted by `delta`. Parts keep a rotation or flip made mid-drag,
 * which only `current`, the schematic as it is now, has.
 */
export function draggedSchematic(current: FullSchematic, built: BuiltNetlist, drag: SchematicDrag, delta: Point): FullSchematic {
  const refs = selectedRefs(drag.moving)
  const now = new Map(current.placements.map((p) => [p.ref, p]))
  const placements = drag.base.placements
    .filter((p) => refs.includes(p.ref))
    .map((origin) => ({ ...(now.get(origin.ref) ?? origin), ...snapPoint({ x: origin.x + delta.x, y: origin.y + delta.y }) }))
  return withSchematicMoved(drag.base, built, {
    placements,
    wiring: selectedWiring(drag.moving),
    delta,
    keepConnections: drag.keepConnections,
  })
}

/** Which way a label's name points: away from the pin it sits on, above a horizontal wire, else to the right. */
export function labelDirection(label: Point, parts: PlacedPart[], wires: Wire[]): Point {
  const pinDirections = new Map(parts.flatMap(({ pins }) => pins.map((pin) => [pointKey(pin), { x: pin.dx, y: pin.dy }] as const)))
  const pin = pinDirections.get(pointKey(label))
  if (pin) return pin
  const onHorizontalWire = wires.some((w) => w.y1 === w.y2 && w.y1 === label.y && Math.min(w.x1, w.x2) <= label.x && label.x <= Math.max(w.x1, w.x2))
  return onHorizontalWire ? { x: 0, y: -1 } : { x: 1, y: 0 }
}
