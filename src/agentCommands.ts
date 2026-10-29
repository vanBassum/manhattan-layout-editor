// Layout inspection and edits as used by the AI agent bridge. Pure functions: they read a project
// and return a description or a new layout; App applies the layout (with undo).

import { footprintPinCount } from './footprints'
import { boundsOf } from './geometry'
import { analyzeLeads, bodyBounds, changeFootprints, componentGeometry, findSpacingViolations, findSplitNets, toLocal, toWorld } from './layout'
import type { Island, Layout, NetComponent, Netlist, Placement, Point, Project, Rect } from './types'

const round = (v: number) => Math.round(v * 100) / 100
const roundPoint = (p: Point) => ({ x: round(p.x), y: round(p.y) })
const roundRect = (r: Rect) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) })

export interface Problems {
  openPins: string[]
  shortedPins: string[]
  netsTooClose: string[]
  splitNets: string[]
}

export function findProblems(project: Project): Problems {
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

function placedComponents(project: Project) {
  return project.layout.placements.flatMap((placement) => {
    const component = project.netlist.components.find((c) => c.ref === placement.ref)
    return component ? [{ component, placement }] : []
  })
}

/** Bounding box of all copper and components. */
export function layoutBounds(project: Project): Rect | null {
  const parts = placedComponents(project).map(({ component, placement }) => {
    const geometry = componentGeometry(component)
    return bodyBounds(geometry, placement, geometry.anchors)
  })
  const lead = placedComponents(project).flatMap(({ component, placement }) =>
    analyzeLeads(component, placement, project.layout.islands, project.settings.isolation).map((l) => ({ ...l.end, w: 0, h: 0 })),
  )
  return boundsOf([...project.layout.islands.flatMap((i) => i.rects), ...parts, ...lead])
}

export function describeProject(project: Project) {
  const { netlist, layout, settings } = project
  return {
    project: { guid: project.guid, name: project.name },
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
      const geometry = componentGeometry(component)
      const { x, y, w, h } = geometry.body
      const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
      const leads = analyzeLeads(component, placement, layout.islands, settings.isolation, geometry)
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

function stringArg(args: Args, name: string): string {
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

function requireComponent(project: Project, ref: string): { component: NetComponent; placement: Placement } {
  const found = placedComponents(project).find(({ component }) => component.ref === ref)
  if (!found) throw new Error(`No component "${ref}". Known: ${project.netlist.components.map((c) => c.ref).join(', ')}`)
  return found
}

function requireIsland(project: Project, net: string): Island {
  const island = project.layout.islands.find((i) => i.net === net)
  if (!island) throw new Error(`No island for net "${net}". Known: ${project.layout.islands.map((i) => i.net).join(', ')}`)
  return island
}

const replacePlacement = (layout: Layout, placement: Placement): Layout => ({
  ...layout,
  placements: layout.placements.map((p) => (p.ref === placement.ref ? placement : p)),
})

const replaceIsland = (layout: Layout, island: Island): Layout => ({
  ...layout,
  islands: layout.islands.map((i) => (i.net === island.net ? island : i)),
})

export function moveComponent(project: Project, args: Args): Layout {
  const { placement } = requireComponent(project, stringArg(args, 'ref'))
  return replacePlacement(project.layout, {
    ...placement,
    x: optionalNumberArg(args, 'x') ?? placement.x,
    y: optionalNumberArg(args, 'y') ?? placement.y,
    rotation: optionalNumberArg(args, 'rotation') ?? placement.rotation,
  })
}

export function setLeadEnd(project: Project, args: Args): Layout {
  const { component, placement } = requireComponent(project, stringArg(args, 'ref'))
  const pin = stringArg(args, 'pin')
  if (!component.pins.some((p) => p.number === pin)) {
    throw new Error(`${component.ref} has no pin "${pin}". Pins: ${component.pins.map((p) => p.number).join(', ')}`)
  }
  const end = toLocal({ x: numberArg(args, 'x'), y: numberArg(args, 'y') }, placement)
  return replacePlacement(project.layout, { ...placement, leads: { ...placement.leads, [pin]: end } })
}

export function resetLeads(project: Project, args: Args): Layout {
  const { placement } = requireComponent(project, stringArg(args, 'ref'))
  return replacePlacement(project.layout, { ...placement, leads: undefined })
}

export function setIsland(project: Project, args: Args): Layout {
  const island = requireIsland(project, stringArg(args, 'net'))
  const rects = args.rects
  if (!Array.isArray(rects) || rects.length === 0) throw new Error('"rects" must be a non-empty array')
  const parsed = rects.map((r: Args) => {
    const rect = { x: numberArg(r, 'x'), y: numberArg(r, 'y'), w: numberArg(r, 'w'), h: numberArg(r, 'h') }
    if (rect.w <= 0 || rect.h <= 0) throw new Error('rectangles need a positive width and height')
    return rect
  })
  return replaceIsland(project.layout, { ...island, rects: parsed })
}

export function moveIsland(project: Project, args: Args): Layout {
  const island = requireIsland(project, stringArg(args, 'net'))
  const dx = numberArg(args, 'dx')
  const dy = numberArg(args, 'dy')
  return replaceIsland(project.layout, { ...island, rects: island.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) })
}

/**
 * Builds the given parts with `footprint`, or with their netlist footprint again when it is null.
 * `imported` is the netlist without footprint choices. Library footprints must match each part's pin
 * count; other footprint names cannot be checked and are accepted as given.
 */
export function setFootprint(project: Project, imported: Netlist, args: Args): Layout {
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

const BATCH_EDITS: Record<string, (project: Project, args: Args) => Layout> = {
  move_component: moveComponent,
  set_lead_end: setLeadEnd,
  reset_leads: resetLeads,
  set_island: setIsland,
  move_island: moveIsland,
}

/** Applies several edits in order, each seeing the result of the previous one. All or nothing. */
export function applyBatch(project: Project, args: Args): Layout {
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
      throw new Error(`edit ${k + 1} (${command}): ${e instanceof Error ? e.message : String(e)}; nothing was changed`)
    }
  })
  return layout
}
