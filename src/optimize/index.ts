import { knifeStrategy } from './knife'
import { manhattanStrategy } from './manhattan'
import type { Strategy } from './strategy'

export const STRATEGIES: Strategy[] = [knifeStrategy, manhattanStrategy]

export function findStrategy(id: string): Strategy {
  const strategy = STRATEGIES.find((s) => s.id === id)
  if (!strategy) throw new Error(`Unknown strategy "${id}"; choose ${STRATEGIES.map((s) => `"${s.id}"`).join(' or ')}`)
  return strategy
}
