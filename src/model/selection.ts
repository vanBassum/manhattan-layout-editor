import { samePoint } from './geometry'
import type { Point, Selection, WiringSelection } from './types'

/** One part or one island: the selections that the single-item tools (rotate, resize, add rect) work on. */
export type SingleSelection = Exclude<Selection, null | { kind: 'multi' }>

/** One thing in the schematic that a click selects. */
export type SchematicItem =
  | { kind: 'part'; ref: string }
  | { kind: 'wire'; index: number }
  | { kind: 'label'; index: number }
  | { kind: 'point'; point: Point }

export const NO_WIRING: WiringSelection = { wires: [], labels: [], points: [] }

const isEmptyWiring = (wiring: WiringSelection) => wiring.wires.length + wiring.labels.length + wiring.points.length === 0

export function selectedRefs(selection: Selection): string[] {
  if (selection?.kind === 'part') return [selection.ref]
  if (selection?.kind === 'multi') return selection.refs
  return []
}

export function selectedNets(selection: Selection): string[] {
  if (selection?.kind === 'island') return [selection.net]
  if (selection?.kind === 'multi') return selection.nets
  return []
}

export function selectedWiring(selection: Selection): WiringSelection {
  return (selection?.kind === 'multi' && selection.wiring) || NO_WIRING
}

/** A lone part or island keeps its single kind, so the single-item tools keep working on it. */
export function selectionOf(refs: string[], nets: string[], wiring: WiringSelection = NO_WIRING): Selection {
  if (!isEmptyWiring(wiring)) return { kind: 'multi', refs, nets, wiring }
  if (refs.length === 0 && nets.length === 0) return null
  if (refs.length === 1 && nets.length === 0) return { kind: 'part', ref: refs[0] }
  if (refs.length === 0 && nets.length === 1) return { kind: 'island', net: nets[0], rectIndex: 0 }
  return { kind: 'multi', refs, nets }
}

export function isSelected(selection: Selection, item: SingleSelection): boolean {
  return item.kind === 'part' ? selectedRefs(selection).includes(item.ref) : selectedNets(selection).includes(item.net)
}

export function isSchematicItemSelected(selection: Selection, item: SchematicItem): boolean {
  const wiring = selectedWiring(selection)
  switch (item.kind) {
    case 'part':
      return selectedRefs(selection).includes(item.ref)
    case 'wire':
      return wiring.wires.includes(item.index)
    case 'label':
      return wiring.labels.includes(item.index)
    case 'point':
      return wiring.points.some((p) => samePoint(p, item.point))
  }
}

export function schematicItemSelection(item: SchematicItem): Selection {
  return item.kind === 'part' ? item : selectionOf([], [], { ...NO_WIRING, ...wiringOf(item) })
}

function wiringOf(item: Exclude<SchematicItem, { kind: 'part' }>): Partial<WiringSelection> {
  if (item.kind === 'wire') return { wires: [item.index] }
  if (item.kind === 'label') return { labels: [item.index] }
  return { points: [item.point] }
}

const unionPoints = (a: Point[], b: Point[]) => [...a, ...b.filter((p) => !a.some((q) => samePoint(p, q)))]

export function addToSelection(selection: Selection, refs: string[], nets: string[], wiring: WiringSelection = NO_WIRING): Selection {
  const allRefs = [...new Set([...selectedRefs(selection), ...refs])]
  const allNets = [...new Set([...selectedNets(selection), ...nets])]
  const current = selectedWiring(selection)
  return selectionOf(allRefs, allNets, {
    wires: [...new Set([...current.wires, ...wiring.wires])],
    labels: [...new Set([...current.labels, ...wiring.labels])],
    points: unionPoints(current.points, wiring.points),
  })
}

/** Shift, Ctrl or Cmd held: a click toggles the item, a selection rectangle adds to the selection. */
export const isToggleClick = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => e.shiftKey || e.ctrlKey || e.metaKey

/** Shift/Ctrl+click: adds the item to the selection, or takes it out again. */
export function toggleSelected(selection: Selection, item: SingleSelection): Selection {
  // Keeps the clicked rectangle of an island, so its resize handles appear where you clicked.
  if (selection === null) return item
  const refs = selectedRefs(selection)
  const nets = selectedNets(selection)
  const wiring = selectedWiring(selection)
  if (item.kind === 'part') {
    return selectionOf(refs.includes(item.ref) ? refs.filter((r) => r !== item.ref) : [...refs, item.ref], nets, wiring)
  }
  return selectionOf(refs, nets.includes(item.net) ? nets.filter((n) => n !== item.net) : [...nets, item.net], wiring)
}

/** Shift/Ctrl+click in the schematic: adds a part, wire, label or wire end, or takes it out again. */
export function toggleSchematicItem(selection: Selection, item: SchematicItem): Selection {
  if (item.kind === 'part') return toggleSelected(selection, item)
  const refs = selectedRefs(selection)
  const nets = selectedNets(selection)
  const wiring = selectedWiring(selection)
  const toggle = <T,>(list: T[], value: T, same: (a: T, b: T) => boolean) =>
    list.some((v) => same(v, value)) ? list.filter((v) => !same(v, value)) : [...list, value]
  const next =
    item.kind === 'wire'
      ? { ...wiring, wires: toggle(wiring.wires, item.index, (a, b) => a === b) }
      : item.kind === 'label'
        ? { ...wiring, labels: toggle(wiring.labels, item.index, (a, b) => a === b) }
        : { ...wiring, points: toggle(wiring.points, item.point, samePoint) }
  return selectionOf(refs, nets, next)
}
