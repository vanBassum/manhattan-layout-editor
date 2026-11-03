import type { BuiltNetlist, Layout, Settings, StrategyId } from '../types'
import { knifeStrategy } from './knife'
import { manhattanStrategy } from './manhattan'

/**
 * A layout strategy builds a complete, editable layout from the netlist. It only decides geometry:
 * islands are still one per net and parts still connect to the nets the netlist says.
 */
export interface Strategy {
  id: StrategyId
  label: string
  description: string
  run: (netlist: BuiltNetlist, settings: Settings) => Layout
}

export const STRATEGIES: Strategy[] = [knifeStrategy, manhattanStrategy]

export function findStrategy(id: string): Strategy {
  const strategy = STRATEGIES.find((s) => s.id === id)
  if (!strategy) throw new Error(`Unknown strategy "${id}"; choose ${STRATEGIES.map((s) => `"${s.id}"`).join(' or ')}`)
  return strategy
}
