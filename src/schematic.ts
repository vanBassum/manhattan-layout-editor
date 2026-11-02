import { snapToGrid } from './geometry'
import type { Netlist, Schematic, SchematicPlacement } from './types'

/** Every pin end sits on this grid (0.1 inch), as long as symbols are placed on it too. */
export const SCHEMATIC_GRID = 2.54
export const CELL_WIDTH = 10 * SCHEMATIC_GRID
export const CELL_HEIGHT = 7 * SCHEMATIC_GRID

/**
 * A placement for every component, in netlist order: stored ones as they are, the rest on a grid
 * below them. Placements of components no longer in the netlist are left out.
 */
export function completeSchematic(netlist: Netlist, schematic: Schematic | undefined): SchematicPlacement[] {
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

/** The schematic with an agent's placements applied: snapped to the grid, rotation in quarter turns. */
export function withAgentPlacements(netlist: Netlist, schematic: Schematic | undefined, placements: unknown): Schematic {
  if (!Array.isArray(placements)) throw new Error('"placements" must be an array')
  const refs = new Set(netlist.components.map((c) => c.ref))
  const updates = new Map<string, SchematicPlacement>()
  for (const item of placements as Partial<SchematicPlacement>[]) {
    const { ref, x, y, rotation = 0 } = item
    if (typeof ref !== 'string' || !refs.has(ref)) throw new Error(`Unknown component "${String(ref)}"`)
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error(`${ref}: x and y must be numbers`)
    if (rotation % 90 !== 0) throw new Error(`${ref}: rotation must be a multiple of 90`)
    updates.set(ref, {
      ref,
      x: snapToGrid(x, SCHEMATIC_GRID),
      y: snapToGrid(y, SCHEMATIC_GRID),
      rotation: ((rotation % 360) + 360) % 360,
    })
  }
  return { placements: completeSchematic(netlist, schematic).map((p) => updates.get(p.ref) ?? p) }
}
