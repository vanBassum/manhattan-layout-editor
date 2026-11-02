// Until November 2026 a layout could be a solid board split by cut lines ("Knife – cut lines"),
// with the islands following from the cuts and from where the leads end. That mode is gone:
// such a layout becomes the islands its cuts gave, which every editing mode can work on.

import { buildNetlist } from './definitions'
import { defaultLeadEnds, toWorld } from './layout'
import { islandsFromCuts } from './raster'
import type { CutBoard, Layout, Project } from './types'

const CUT_LINES_STRATEGY = 'knife-cuts'

type CutLineLayout = Layout & { knife?: CutBoard; freeCopper?: unknown }

export function withoutCutLines(project: Project): Project {
  const { knife, freeCopper: _derived, ...layout } = project.layout as CutLineLayout
  const strategy = project.settings.strategy === CUT_LINES_STRATEGY ? 'knife' : project.settings.strategy
  const settings = { ...project.settings, strategy }
  if (!knife) return { ...project, settings }

  const netlist = buildNetlist(project.netlist, layout.placements, project.definitions)
  const components = new Map(netlist.components.map((c) => [c.ref, c]))
  const leadEnds = layout.placements.flatMap((placement) => {
    const component = components.get(placement.ref)
    if (!component) return []
    const defaults = defaultLeadEnds(component.geometry)
    return component.pins.map((pin, k) => ({ net: pin.net, end: toWorld(placement.leads?.[pin.number] ?? defaults[k], placement) }))
  })
  // Copper no lead reaches had no net; it is left out.
  const { islands } = islandsFromCuts(knife, leadEnds)
  return { ...project, settings, layout: { ...layout, islands } }
}
