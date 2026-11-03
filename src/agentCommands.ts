// Layout inspection and edits as used by the AI agent bridge. Pure functions: they read a project
// and return a description or a new layout (or netlist); App applies it (with undo).

import { buildNetlist, withAssignedDefinition } from './definitions'
import { errorText } from './errorText'
import { footprintPinCount } from './footprints'
import { boundsOf } from './geometry'
import { analyzeLeads, bodyBounds, changeFootprints, createLayout, findSpacingViolations, findSplitNets, replaceIslandRects, toLocal, toWorld } from './layout'
import { isRealNet, naturalCompare } from './netlist'
import { agentPlacements, completeSchematic, pinEnds } from './schematic'
import type { BuiltComponent, BuiltProject, Island, Layout, NetLabel, Netlist, Pin, Placement, Point, Project, Rect, Schematic } from './types'

const round = (v: number) => Math.round(v * 100) / 100
const roundPoint = (p: Point) => ({ x: round(p.x), y: round(p.y) })
const roundRect = (r: Rect) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })

export interface Problems {
  openPins: string[]
  shortedPins: string[]
  netsTooClose: string[]
  splitNets: string[]
}

export function findProblems(project: BuiltProject): Problems {
  const problems: Problems = {
    openPins: [],
    shortedPins: [],
    netsTooClose: [...findSpacingViolations(project.layout.islands)],
    splitNets: [...findSplitNets(project.layout.islands)],
  }
  for (const { component, placement } of placedComponents(project)) {
    analyzeLeads(component, placement, project.layout.islands, project.settings.isolation).forEach((lead, k) => {
      const label = `${component.ref}.${component.pins[k].number} (${lead.net})`
      if (lead.status === 'open') problems.openPins.push(label)
      if (lead.status === 'short') problems.shortedPins.push(label)
    })
  }
  return problems
}

function placedComponents(project: BuiltProject) {
  return project.layout.placements.flatMap((placement) => {
    const component = project.netlist.components.find((c) => c.ref === placement.ref)
    return component ? [{ component, placement }] : []
  })
}

/** Bounding box of all copper and components. */
export function layoutBounds(project: BuiltProject): Rect | null {
  const parts = placedComponents(project).map(({ component, placement }) => {
    const { geometry } = component
    return bodyBounds(geometry, placement, geometry.anchors)
  })
  const lead = placedComponents(project).flatMap(({ component, placement }) =>
    analyzeLeads(component, placement, project.layout.islands, project.settings.isolation).map((l) => ({ ...l.end, w: 0, h: 0 })),
  )
  return boundsOf([...project.layout.islands.flatMap((i) => i.rects), ...parts, ...lead])
}

export function describeProject(project: BuiltProject) {
  const { netlist, layout, settings } = project
  return {
    project: { guid: project.guid },
    units: 'mm; x to the right, y down; rotation in degrees clockwise',
    islands:
      'Islands of different nets touch edge to edge; their shared edge is where the isolation is cut. ' +
      'The copper left is each island shrunk by isolation/2 on every outer edge, so a lead end must lie at ' +
      'least isolation/2 inside its island. Islands of different nets must not overlap.',
    settings: { isolation: settings.isolation, snap: settings.snap, clearance: settings.clearance, maxLead: settings.maxLead },
    bounds: layoutBounds(project),
    nets: netlist.nets.map((net) => {
      const island = layout.islands.find((i) => i.net === net)
      return {
        net,
        pins: netlist.components.flatMap((c) => c.pins.filter((p) => p.net === net).map((p) => `${c.ref}.${p.number}`)),
        island: island ? { plane: island.plane ?? false, rects: island.rects.map(roundRect) } : null,
      }
    }),
    components: placedComponents(project).map(({ component, placement }) => {
      const { geometry } = component
      const { x, y, w, h } = geometry.body
      const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
      const leads = analyzeLeads(component, placement, layout.islands, settings.isolation)
      return {
        ref: component.ref,
        value: component.value,
        footprint: component.footprint,
        shape: geometry.shape,
        x: round(placement.x),
        y: round(placement.y),
        rotation: placement.rotation,
        bodyCorners: corners.map((p) => roundPoint(toWorld(p, placement))),
        maxLeadLength: Math.min(geometry.maxLeadLength, settings.maxLead),
        pins: component.pins.map((pin, k) => ({
          pin: pin.number,
          net: pin.net,
          leadAnchor: roundPoint(leads[k].anchor),
          leadEnd: roundPoint(leads[k].end),
          leadLength: round(Math.hypot(leads[k].end.x - leads[k].anchor.x, leads[k].end.y - leads[k].anchor.y)),
          status: leads[k].status,
        })),
      }
    }),
    problems: findProblems(project),
  }
}

// ---------- Edits ----------

type Args = Record<string, unknown>

export function stringArg(args: Args, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value === '') throw new Error(`"${name}" must be a non-empty string`)
  return value
}

function numberArg(args: Args, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`"${name}" must be a number`)
  return value
}

const optionalNumberArg = (args: Args, name: string) => (args[name] === undefined ? undefined : numberArg(args, name))

function requireComponent(project: BuiltProject, ref: string): { component: BuiltComponent; placement: Placement } {
  const found = placedComponents(project).find(({ component }) => component.ref === ref)
  if (!found) throw new Error(`No component "${ref}". Known: ${project.netlist.components.map((c) => c.ref).join(', ')}`)
  return found
}

function requireIsland(project: BuiltProject, net: string): Island {
  const island = project.layout.islands.find((i) => i.net === net)
  if (!island) throw new Error(`No island for net "${net}". Known: ${project.layout.islands.map((i) => i.net).join(', ')}`)
  return island
}

const replacePlacement = (layout: Layout, placement: Placement): Layout => ({
  ...layout,
  placements: layout.placements.map((p) => (p.ref === placement.ref ? placement : p)),
})

export function moveComponent(project: BuiltProject, args: Args): Layout {
  const { placement } = requireComponent(project, stringArg(args, 'ref'))
  return replacePlacement(project.layout, {
    ...placement,
    x: optionalNumberArg(args, 'x') ?? placement.x,
    y: optionalNumberArg(args, 'y') ?? placement.y,
    rotation: optionalNumberArg(args, 'rotation') ?? placement.rotation,
  })
}

export function setLeadEnd(project: BuiltProject, args: Args): Layout {
  const { component, placement } = requireComponent(project, stringArg(args, 'ref'))
  const pin = stringArg(args, 'pin')
  if (!component.pins.some((p) => p.number === pin)) {
    throw new Error(`${component.ref} has no pin "${pin}". Pins: ${component.pins.map((p) => p.number).join(', ')}`)
  }
  const end = toLocal({ x: numberArg(args, 'x'), y: numberArg(args, 'y') }, placement)
  return replacePlacement(project.layout, { ...placement, leads: { ...placement.leads, [pin]: end } })
}

export function resetLeads(project: BuiltProject, args: Args): Layout {
  const { placement } = requireComponent(project, stringArg(args, 'ref'))
  return replacePlacement(project.layout, { ...placement, leads: undefined })
}

export function setIsland(project: BuiltProject, args: Args): Layout {
  const island = requireIsland(project, stringArg(args, 'net'))
  const rects = args.rects
  if (!Array.isArray(rects) || rects.length === 0) throw new Error('"rects" must be a non-empty array')
  const parsed = rects.map((r: Args) => {
    const rect = { x: numberArg(r, 'x'), y: numberArg(r, 'y'), w: numberArg(r, 'w'), h: numberArg(r, 'h') }
    if (rect.w <= 0 || rect.h <= 0) throw new Error('rectangles need a positive width and height')
    return rect
  })
  return replaceIslandRects(project.layout, island.net, parsed)
}

export function moveIsland(project: BuiltProject, args: Args): Layout {
  const island = requireIsland(project, stringArg(args, 'net'))
  const dx = numberArg(args, 'dx')
  const dy = numberArg(args, 'dy')
  return replaceIslandRects(project.layout, island.net, island.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })))
}

/**
 * Builds the given parts with `footprint`, or with their netlist footprint again when it is null.
 * `imported` is the netlist without footprint choices. Library footprints must match each part's pin
 * count; other footprint names cannot be checked and are accepted as given.
 */
export function setFootprint(project: BuiltProject, imported: Netlist, args: Args): Layout {
  const refs = args.refs
  if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) => typeof ref !== 'string')) {
    throw new Error('"refs" must be a non-empty array of component references')
  }
  const footprint = args.footprint === null ? undefined : stringArg(args, 'footprint')
  const pins = footprint === undefined ? undefined : footprintPinCount(footprint)
  for (const ref of refs as string[]) {
    const { component } = requireComponent(project, ref)
    if (pins !== undefined && pins !== component.pins.length) {
      throw new Error(`${footprint} has ${pins} pins but ${ref} has ${component.pins.length}; nothing was changed`)
    }
  }
  return changeFootprints(imported, project.layout, new Set(refs as string[]), footprint)
}

/** An agent's pin list: unique pin numbers, each with the net it joins ('' or missing: none). */
function pinsArg(pins: unknown): Pin[] {
  if (!Array.isArray(pins) || pins.length === 0) throw new Error('"pins" must be a non-empty array of {number, net?}')
  const numbers = new Set<string>()
  return pins.map((pin: { number?: unknown; net?: unknown }, k) => {
    if (typeof pin?.number !== 'string' || pin.number === '') throw new Error(`pins[${k}] needs a "number"`)
    if (numbers.has(pin.number)) throw new Error(`pin ${pin.number} is listed twice`)
    if (pin.net !== undefined && typeof pin.net !== 'string') throw new Error(`pin ${pin.number}: "net" must be a string`)
    numbers.add(pin.number)
    return { number: pin.number, net: pin.net?.trim() ?? '' }
  })
}

/**
 * The project with a new part. Each pin joins the net given for it: the PCB netlist gets the net and
 * the schematic a net label on the pin end, so the two agree. The part's symbol goes to x/y, or below
 * the others; on the PCB it gets a spot on the grid, and new nets get an island.
 */
export function addComponent(project: Project, args: Args): Pick<Project, 'netlist' | 'layout' | 'schematic'> {
  const ref = stringArg(args, 'ref')
  if (project.netlist.components.some((c) => c.ref === ref)) throw new Error(`There already is a component "${ref}"`)
  const definitionId = args.definition === undefined ? undefined : stringArg(args, 'definition')
  const definition = definitionId === undefined ? undefined : project.definitions?.[definitionId]
  if (definitionId !== undefined && !definition) throw new Error(`Unknown definition "${definitionId}"`)
  const pins =
    args.pins === undefined && definition ? definition.pins.map((p) => ({ number: p.number, net: '' })) : pinsArg(args.pins)
  pins.sort((a, b) => naturalCompare(a.number, b.number))
  const footprint = args.footprint === undefined ? Object.keys(definition?.footprints ?? {})[0] ?? '' : stringArg(args, 'footprint')
  if (args.value !== undefined && typeof args.value !== 'string') throw new Error('"value" must be a string')
  const value = args.value?.trim() ?? ''

  const components = [...project.netlist.components, { ref, value, footprint, pins }].sort((a, b) => naturalCompare(a.ref, b.ref))
  const nets = new Set([...project.netlist.nets, ...pins.map((p) => p.net).filter(isRealNet)])
  let netlist: Netlist = { components, nets: [...nets].sort(naturalCompare) }
  // Refuses a definition that lacks one of the pins.
  if (definitionId !== undefined) netlist = withAssignedDefinition(netlist, project.definitions, [ref], definitionId)
  const built = buildNetlist(netlist, project.layout.placements, project.definitions)
  const layout = createLayout(built, project.layout)

  const placed = args.x === undefined && args.y === undefined ? [] : agentPlacements(netlist, [{ ...args, ref }])
  let schematic: Schematic | undefined =
    project.schematic || placed.length > 0 ? { ...project.schematic, placements: [...(project.schematic?.placements ?? []), ...placed] } : undefined
  // A schematic without labels of its own labels every pin from the netlist already.
  if (schematic?.labels) {
    const full = completeSchematic(built, schematic)
    const index = built.components.findIndex((c) => c.ref === ref)
    const ends = pinEnds(built.components[index], full.placements[index])
    const labels: NetLabel[] = built.components[index].pins.flatMap((pin, k) => (isRealNet(pin.net) ? [{ x: ends[k].x, y: ends[k].y, name: pin.net }] : []))
    schematic = { ...schematic, labels: [...schematic.labels, ...labels] }
  }
  return { netlist, layout, schematic }
}

const BATCH_EDITS: Record<string, (project: BuiltProject, args: Args) => Layout> = {
  move_component: moveComponent,
  set_lead_end: setLeadEnd,
  reset_leads: resetLeads,
  set_island: setIsland,
  move_island: moveIsland,
}

/** Applies several edits in order, each seeing the result of the previous one. All or nothing. */
export function applyBatch(project: BuiltProject, args: Args): Layout {
  const edits = args.edits
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('"edits" must be a non-empty array')
  let layout = project.layout
  edits.forEach((edit: Args, k) => {
    const command = String(edit.command)
    const apply = BATCH_EDITS[command]
    if (!apply) throw new Error(`edit ${k + 1}: unknown command "${command}". Known: ${Object.keys(BATCH_EDITS).join(', ')}`)
    try {
      layout = apply({ ...project, layout }, (edit.args ?? {}) as Args)
    } catch (e) {
      throw new Error(`edit ${k + 1} (${command}): ${errorText(e)}; nothing was changed`)
    }
  })
  return layout
}
