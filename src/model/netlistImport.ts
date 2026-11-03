// Importing a netlist file into a project: as a fresh start, or again over the project's own work.

import { buildNetlist, withDefinitions, withoutUnfitDefinitions } from './definitions'
import { createLayout } from './layout'
import { parseNetlist } from './netlist'
import { netlistSchematic } from './schematic'
import type { Project, Settings } from './types'

/** A project that starts over from netlist `text`, on a fresh grid, with a schematic that labels every pin with its net. */
export function importedProject(text: string, guid: string, settings: Settings): Project {
  const netlist = parseNetlist(text)
  // Without definitions every part builds with the template withDefinitions then stores for it.
  const built = buildNetlist(netlist, [], undefined)
  return withDefinitions({
    guid,
    netlist,
    layout: createLayout(built),
    schematic: netlistSchematic(built, []),
    definitions: undefined,
    settings,
  })
}

/**
 * `current` with netlist `text` imported again; it stays the same project, so it keeps its guid.
 * Parts, islands and schematic symbols stay where they were; wires and labels start over from the
 * imported nets.
 */
export function reimportedProject(text: string, current: Project): Project {
  const imported = parseNetlist(text)
  // A value typed in the editor survives a re-import that still has none (EasyEDA exports "{Value}"
  // as empty), and so does the part's definition, unless its pins changed and it no longer fits.
  const previous = new Map(current.netlist.components.map((c) => [c.ref, c]))
  const netlist = withoutUnfitDefinitions(
    {
      ...imported,
      components: imported.components.map((c) => ({
        ...c,
        value: c.value || previous.get(c.ref)?.value || '',
        definition: previous.get(c.ref)?.definition,
      })),
    },
    current.definitions,
  )
  const built = buildNetlist(netlist, current.layout.placements, current.definitions)
  return withDefinitions({
    guid: current.guid,
    netlist,
    layout: createLayout(built, current.layout),
    schematic: netlistSchematic(built, current.schematic.placements),
    definitions: current.definitions,
    settings: current.settings,
  })
}
