import type { FullSchematic } from '../model/schematic'
import type { BuildStyleId, BuiltNetlist, Layout, PlacementId, Settings } from '../model/types'
import type { PlacedPart } from './common'
import { placeFromSchematic } from './fromSchematic'
import { knifeCopper } from './knife'
import { manhattanCopper } from './manhattan'

/**
 * How the copper is made for parts that are already placed. It only decides geometry: islands are
 * one per net and parts connect to the nets the netlist says.
 */
export interface BuildStyle {
  id: BuildStyleId
  label: string
  description: string
  /** Whether a clicked rectangle of an island gets resize handles, or the island is only edited by its outline. */
  rectHandles: boolean
  copper: (netlist: BuiltNetlist, parts: PlacedPart[], settings: Settings) => Layout
}

/**
 * Where the parts go. The schematic tells where the user drew each part; its nets are not the
 * PCB's until "Update PCB".
 */
export interface PlacementAlgorithm {
  id: PlacementId
  label: string
  description: string
  place: (netlist: BuiltNetlist, settings: Settings, schematic: FullSchematic) => PlacedPart[]
}

export const BUILD_STYLES: BuildStyle[] = [
  {
    id: 'knife',
    label: 'Knife',
    description: 'A copper board cut into islands, one per net',
    // An island is a polygon of many strips; handles on its strips would only get in the way.
    rectHandles: false,
    copper: knifeCopper,
  },
  {
    id: 'manhattan',
    label: 'Manhattan',
    description: 'Pads glued on a copper board that is the ground plane, one pad per net',
    rectHandles: true,
    copper: manhattanCopper,
  },
]

export const PLACEMENTS: PlacementAlgorithm[] = [
  {
    id: 'schematic',
    label: 'Schematic',
    description: 'Every part where it is drawn in the schematic, turned the way its symbol points',
    place: placeFromSchematic,
  },
]

const choices = (ids: string[]) => ids.map((id) => `"${id}"`).join(' or ')

export function findBuildStyle(id: string): BuildStyle {
  const style = BUILD_STYLES.find((s) => s.id === id)
  if (!style) throw new Error(`Unknown build style "${id}"; choose ${choices(BUILD_STYLES.map((s) => s.id))}`)
  return style
}

export function findPlacement(id: string): PlacementAlgorithm {
  const placement = PLACEMENTS.find((p) => p.id === id)
  if (!placement) throw new Error(`Unknown placement "${id}"; choose ${choices(PLACEMENTS.map((p) => p.id))}`)
  return placement
}

/** A complete layout: the parts placed by the chosen placement, then the copper of the chosen build style. */
export function optimizedLayout(netlist: BuiltNetlist, settings: Settings, schematic: FullSchematic): Layout {
  const parts = findPlacement(settings.placement).place(netlist, settings, schematic)
  return findBuildStyle(settings.buildStyle).copper(netlist, parts, settings)
}
