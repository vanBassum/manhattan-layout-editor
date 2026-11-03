import type { Project } from './types'

const UNDO_LIMIT = 100

/** What one undo step restores. */
export type Snapshot = Pick<Project, 'netlist' | 'layout' | 'schematic' | 'definitions' | 'simulation'>

export const snapshotOf = (project: Project): Snapshot => ({
  netlist: project.netlist,
  layout: project.layout,
  schematic: project.schematic,
  definitions: project.definitions,
  simulation: project.simulation,
})

/** Never changed in place, so tabs can share NO_HISTORY and a parked history stays as it was. */
export interface History {
  readonly undo: readonly Snapshot[]
  readonly redo: readonly Snapshot[]
}

export const NO_HISTORY: History = { undo: [], redo: [] }

/** `history` with `before` as the newest undo step; a new edit drops what could be redone. */
export const withEdit = (history: History, before: Snapshot): History => ({
  undo: [...history.undo.slice(-(UNDO_LIMIT - 1)), before],
  redo: [],
})

/** One step back (undo) or forward (redo) from `current`; null when there is nothing to step to. */
export function stepHistory(
  history: History,
  current: Snapshot,
  direction: 'undo' | 'redo',
): { history: History; restored: Snapshot } | null {
  const from = direction === 'undo' ? history.undo : history.redo
  const restored = from.at(-1)
  if (!restored) return null
  const remaining = from.slice(0, -1)
  return direction === 'undo'
    ? { restored, history: { undo: remaining, redo: [...history.redo, current] } }
    : { restored, history: { undo: [...history.undo, current], redo: remaining } }
}
