import type { Layout, Netlist, Settings } from '../types'
import { knifeStrategy } from './knife'
import { laserStrategy } from './laser'
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

export const STRATEGIES: Strategy[] = [laserStrategy, knifeStrategy, manhattanStrategy]

export function findStrategy(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0]
}
