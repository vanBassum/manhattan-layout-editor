import { toCutLayout } from '../layout'
import type { Layout, Netlist, Settings } from '../types'
import { knifeStrategy } from './knife'
import { manhattanStrategy } from './manhattan'

/**
 * A layout strategy builds a complete, editable layout from the netlist. It only decides geometry:
 * islands are still one per net and parts still connect to the nets the netlist says.
 */
export interface Strategy {
  id: string
  label: string
  description: string
  run: (netlist: Netlist, settings: Settings) => Layout
}

export const KNIFE_CUTS = 'knife-cuts'

const knifeCutsStrategy: Strategy = {
  id: KNIFE_CUTS,
  label: 'Knife – cut lines',
  description: 'Knife layout edited as cut lines on a solid board; the nets follow from where the leads end',
  run: (netlist, settings) => toCutLayout(knifeStrategy.run(netlist, settings)),
}

export const STRATEGIES: Strategy[] = [knifeStrategy, knifeCutsStrategy, manhattanStrategy]

export function findStrategy(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0]
}
