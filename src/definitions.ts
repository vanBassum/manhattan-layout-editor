import { generatedGeometry, withFootprintChoices, type Geometry } from './layout'
import { symbolTemplate } from './schematicSymbols'
import type { ComponentDefinition, FootprintDefinition, NetComponent, Netlist, Placement, Project, SymbolDefinition } from './types'

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

/** The part's symbol: from its definition on a built netlist, else the built-in template. */
export function componentSymbol(component: NetComponent): SymbolDefinition {
  return component.symbol && hasPins(component.symbol, component) ? component.symbol : symbolTemplate(component).symbol
}

/** The definition a part refers to, if it exists and has all the part's pins. */
function definitionOf(component: NetComponent, definitions: Definitions | undefined): ComponentDefinition | undefined {
  const definition = component.definition ? definitions?.[component.definition] : undefined
  return definition && hasPins(definition.symbol, component) ? definition : undefined
}

/**
 * The netlist as built: footprint choices applied, and each part's geometry and symbol taken from
 * its definition. This is what drawing, checks and optimizers work on; it is never stored.
 */
export function buildNetlist(netlist: Netlist, placements: Placement[], definitions: Definitions | undefined): Netlist {
  const chosen = withFootprintChoices(netlist, placements)
  return {
    ...chosen,
    components: chosen.components.map((component) => {
      const definition = definitionOf(component, definitions)
      const footprint = definition?.footprints[component.footprint]
      return {
        ...component,
        geometry: footprint && geometryFromFootprint(footprint, component),
        symbol: definition?.symbol,
      }
    }),
  }
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
 * The project with a definition for every part and every footprint in use, taken from the
 * built-in templates where the project has none yet. Existing definitions are never changed.
 */
export function withDefinitions(project: Project): Project {
  const definitions: Definitions = { ...project.definitions }
  const chosenFootprints = new Map(project.layout.placements.map((p) => [p.ref, p.footprint]))
  let changed = false
  const components = project.netlist.components.map((component) => {
    let id = definitionOf(component, definitions) ? component.definition! : undefined
    if (id === undefined) {
      const template = templateDefinition(component)
      // A same-named definition that does not fit this part (other pins) gets a part-specific twin.
      const fits = !definitions[template.id] || definitionOf({ ...component, definition: template.id }, definitions)
      id = fits ? template.id : `${template.id}-${component.ref.toLowerCase()}`
      definitions[id] ??= template.definition
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
