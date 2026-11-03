import { knifeStrategy } from './knife'
import { manhattanStrategy } from './manhattan'
import type { Strategy } from './strategy'

export const STRATEGIES: Strategy[] = [knifeStrategy, manhattanStrategy]

export function findStrategy(id: string): Strategy {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0]
}
