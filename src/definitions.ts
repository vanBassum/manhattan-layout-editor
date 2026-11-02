import { generatedGeometry, withFootprintChoices, type Geometry } from './layout'
import { symbolTemplate } from './schematicSymbols'
import type { BuiltNetlist, ComponentDefinition, FootprintDefinition, NetComponent, Netlist, Placement, Project, SymbolDefinition } from './types'

// A part's symbol and footprints come from the project's own definitions. Parts without one get a
// built-in template, which is copied into the project when it is loaded or saved; until then the
// template is used directly, which gives the same result.

type Definitions = Record<string, ComponentDefinition>

function footprintFromGeometry(geometry: Geometry, component: NetComponent): FootprintDefinition {
  return {
    shape: geometry.shape,
    body: geometry.body,
    pins: component.pins.map((pin, k) => ({
      number: pin.number,
      ...geometry.anchors[k],
      dx: geometry.directions[k].x,
      dy: geometry.directions[k].y,
    })),
    leadLength: geometry.leadLength,
    maxLeadLength: geometry.maxLeadLength,
    ...(geometry.led ? { led: true } : {}),
  }
}

/** The footprint as runtime geometry, in the part's pin order; undefined when it lacks one of the part's pins. */
function geometryFromFootprint(footprint: FootprintDefinition, component: NetComponent): Geometry | undefined {
  const byNumber = new Map(footprint.pins.map((p) => [p.number, p]))
  const pins = component.pins.map((p) => byNumber.get(p.number))
  if (pins.some((p) => p === undefined)) return undefined
  return {
    shape: footprint.shape,
    body: footprint.body,
    anchors: pins.map((p) => ({ x: p!.x, y: p!.y })),
    directions: pins.map((p) => ({ x: p!.dx, y: p!.dy })),
    leadLength: footprint.leadLength,
    maxLeadLength: footprint.maxLeadLength,
    led: footprint.led ?? false,
  }
}

const hasPins = (symbol: SymbolDefinition, component: NetComponent) => {
  const numbers = new Set(symbol.pins.map((p) => p.number))
  return component.pins.every((p) => numbers.has(p.number))
}

/** The definition a part refers to, if it exists and has all the part's pins. */
function definitionOf(component: NetComponent, definitions: Definitions | undefined): ComponentDefinition | undefined {
  const definition = component.definition ? definitions?.[component.definition] : undefined
  return definition && hasPins(definition.symbol, component) ? definition : undefined
}

/** The built-in template for a part, with no footprints yet; the id is shared by every part that fits it. */
function templateDefinition(component: NetComponent): { id: string; definition: ComponentDefinition } {
  const template = symbolTemplate(component)
  const numbers = component.pins.map((p) => p.number)
  const numbered = numbers.every((n, k) => n === String(k + 1))
  return {
    id: numbered ? template.kind : `${template.kind}-${numbers.join('-')}`,
    definition: {
      name: template.name,
      pins: component.pins.map((p, k) => (template.pinNames?.[k] ? { number: p.number, name: template.pinNames[k] } : { number: p.number })),
      symbol: template.symbol,
      footprints: {},
    },
  }
}

/**
 * The definition a part uses: its own when it fits, else the project's definition for the built-in
 * template the part fits, else that template. withDefinitions stores exactly this choice, so a part
 * looks the same before and after its project is saved.
 */
function resolvedDefinition(component: NetComponent, definitions: Definitions | undefined): { id: string; definition: ComponentDefinition } {
  const own = definitionOf(component, definitions)
  if (own) return { id: component.definition!, definition: own }
  const template = templateDefinition(component)
  // A same-named definition that does not fit this part (other pins) gets a part-specific twin.
  const fits = !definitions?.[template.id] || definitionOf({ ...component, definition: template.id }, definitions)
  const id = fits ? template.id : `${template.id}-${component.ref.toLowerCase()}`
  return { id, definition: definitions?.[id] ?? template.definition }
}

/**
 * The netlist as built: footprint choices applied, and each part's geometry and symbol taken from
 * its definition. This is what drawing, checks and optimizers work on; it is never stored.
 */
export function buildNetlist(netlist: Netlist, placements: Placement[], definitions: Definitions | undefined): BuiltNetlist {
  const chosen = withFootprintChoices(netlist, placements)
  return {
    ...chosen,
    components: chosen.components.map((component) => {
      const { definition } = resolvedDefinition(component, definitions)
      const stored = definition.footprints[component.footprint]
      // A footprint the definition does not have yet comes from the template, as withDefinitions will
      // add it. One that lacks some of the part's pins cannot be used for it, so the template stands in.
      const geometry = (stored && geometryFromFootprint(stored, component)) ?? generatedGeometry(component)
      return { ...component, geometry, symbol: definition.symbol }
    }),
  }
}

/** The project's own netlist, built; for the schematic's nets, build those with buildNetlist. */
export const buildProjectNetlist = (project: Project): BuiltNetlist =>
  buildNetlist(project.netlist, project.layout.placements, project.definitions)

/**
 * The project with a definition for every part and every footprint in use, taken from the
 * built-in templates where the project has none yet. Existing definitions are never changed.
 */
export function withDefinitions(project: Project): Project {
  const definitions: Definitions = { ...project.definitions }
  const chosenFootprints = new Map(project.layout.placements.map((p) => [p.ref, p.footprint]))
  let changed = false
  const components = project.netlist.components.map((component) => {
    const { id, definition } = resolvedDefinition(component, definitions)
    if (!definitions[id]) {
      definitions[id] = definition
      changed = true
    }
    for (const name of new Set([component.footprint, chosenFootprints.get(component.ref) ?? component.footprint])) {
      if (definitions[id].footprints[name]) continue
      const footprint = footprintFromGeometry(generatedGeometry({ ...component, footprint: name }), component)
      definitions[id] = { ...definitions[id], footprints: { ...definitions[id].footprints, [name]: footprint } }
      changed = true
    }
    if (component.definition === id) return component
    changed = true
    return { ...component, definition: id }
  })
  if (!changed && project.definitions) return project
  return { ...project, netlist: { ...project.netlist, components }, definitions }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPinList = (v: unknown) => Array.isArray(v) && v.every((p) => isObject(p) && typeof p.number === 'string')

/** An agent's definition, checked for the parts the editor relies on; the rest is taken as given. */
export function checkedDefinition(data: unknown): ComponentDefinition {
  if (!isObject(data)) throw new Error('"definition" must be an object')
  const { name, pins, symbol, footprints } = data
  if (typeof name !== 'string' || name === '') throw new Error('definition needs a "name"')
  if (!isPinList(pins)) throw new Error('"pins" must be a list of {number, name?}')
  if (!isObject(symbol) || !isPinList(symbol.pins) || !Array.isArray(symbol.graphics) || !isObject(symbol.label)) {
    throw new Error('"symbol" needs "pins" ({number, x, y, dx, dy}), "graphics" and "label" ({x, y})')
  }
  if (!isObject(footprints) || !Object.values(footprints).every((f) => isObject(f) && isPinList(f.pins) && isObject(f.body))) {
    throw new Error('"footprints" must map footprint names to {shape, body, pins, leadLength, maxLeadLength}')
  }
  const numbers = (pins as { number: string }[]).map((p) => p.number)
  const symbolNumbers = new Set((symbol.pins as { number: string }[]).map((p) => p.number))
  const missing = numbers.filter((n) => !symbolNumbers.has(n))
  if (missing.length) throw new Error(`symbol has no pin ${missing.join(', ')}`)
  return data as unknown as ComponentDefinition
}

/** The netlist with `refs` using definition `id`; refused for a part whose pins the definition does not have. */
export function withAssignedDefinition(netlist: Netlist, definitions: Definitions | undefined, refs: unknown, id: unknown): Netlist {
  if (typeof id !== 'string' || !definitions?.[id]) throw new Error(`Unknown definition "${String(id)}"`)
  if (!Array.isArray(refs) || refs.length === 0) throw new Error('"refs" must list component references')
  const wanted = new Set(refs.map(String))
  const known = new Set(netlist.components.map((c) => c.ref))
  const unknown = [...wanted].filter((ref) => !known.has(ref))
  if (unknown.length) throw new Error(`Unknown component ${unknown.join(', ')}`)
  return {
    ...netlist,
    components: netlist.components.map((component) => {
      if (!wanted.has(component.ref)) return component
      if (!hasPins(definitions[id].symbol, component)) {
        throw new Error(`${component.ref}: definition "${id}" lacks some of its pins (${component.pins.map((p) => p.number).join(', ')})`)
      }
      return { ...component, definition: id }
    }),
  }
}
