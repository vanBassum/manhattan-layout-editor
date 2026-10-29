import type { Selection } from './types'

/** One part or one island: the selections that the single-item tools (rotate, resize, add rect) work on. */
export type SingleSelection = Exclude<Selection, null | { kind: 'multi' }>

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

/** A lone item keeps its single kind, so the single-item tools keep working on it. */
export function selectionOf(refs: string[], nets: string[]): Selection {
  if (refs.length === 0 && nets.length === 0) return null
  if (refs.length === 1 && nets.length === 0) return { kind: 'part', ref: refs[0] }
  if (refs.length === 0 && nets.length === 1) return { kind: 'island', net: nets[0], rectIndex: 0 }
  return { kind: 'multi', refs, nets }
}

export function isSelected(selection: Selection, item: SingleSelection): boolean {
  return item.kind === 'part' ? selectedRefs(selection).includes(item.ref) : selectedNets(selection).includes(item.net)
}

export function addToSelection(selection: Selection, refs: string[], nets: string[]): Selection {
  const allRefs = [...new Set([...selectedRefs(selection), ...refs])]
  const allNets = [...new Set([...selectedNets(selection), ...nets])]
  return selectionOf(allRefs, allNets)
}

/** Shift/Ctrl+click: adds the item to the selection, or takes it out again. */
export function toggleSelected(selection: Selection, item: SingleSelection): Selection {
  // Keeps the clicked rectangle of an island, so its resize handles appear where you clicked.
  if (selection === null) return item
  const refs = selectedRefs(selection)
  const nets = selectedNets(selection)
  if (item.kind === 'part') {
    return selectionOf(refs.includes(item.ref) ? refs.filter((r) => r !== item.ref) : [...refs, item.ref], nets)
  }
  return selectionOf(refs, nets.includes(item.net) ? nets.filter((n) => n !== item.net) : [...nets, item.net])
}
