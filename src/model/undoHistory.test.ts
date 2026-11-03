import { describe, expect, it } from 'vitest'
import example from '../examples/Astable multivibrator.json?raw'
import { emptyProject, projectFromFile } from '../documents/projectFormat'
import type { Project } from './types'
import { NO_HISTORY, snapshotOf, stepHistory, withEdit } from './undoHistory'

/** `project` with its first part moved to x = `x`. */
const movedTo = (project: Project, x: number): Project => ({
  ...project,
  layout: { ...project.layout, placements: project.layout.placements.map((p, i) => (i === 0 ? { ...p, x } : p)) },
})

describe('undo history', () => {
  it('undoes an edit followed by live updates, such as a drag, in one step', () => {
    const before = projectFromFile(example)
    // As the editor does: remember the project once when the drag starts, then update it without new steps.
    const history = withEdit(NO_HISTORY, snapshotOf(before))
    let dragged = before
    for (let x = 1; x <= 10; x++) dragged = movedTo(dragged, x)

    const undone = stepHistory(history, snapshotOf(dragged), 'undo')!
    expect(undone.restored).toEqual(snapshotOf(before))
    expect(stepHistory(undone.history, undone.restored, 'undo')).toBeNull()
    expect(stepHistory(undone.history, undone.restored, 'redo')!.restored).toEqual(snapshotOf(dragged))
  })

  it('undoes a change to the simulation, such as a source', () => {
    const before = emptyProject()
    const after: Project = { ...before, simulation: { sources: [{ net: 'VCC', shape: 'dc', volts: 9 }], models: {} } }
    const undone = stepHistory(withEdit(NO_HISTORY, snapshotOf(before)), snapshotOf(after), 'undo')!
    expect(undone.restored.simulation).toBeUndefined()
    expect(stepHistory(undone.history, undone.restored, 'redo')!.restored.simulation).toEqual(after.simulation)
  })

  it('undoes edits one at a time, newest first', () => {
    const first = emptyProject()
    const second = { ...first, schematic: { placements: [], wires: [], labels: [] } }
    const third = { ...second, definitions: {} }
    const history = withEdit(withEdit(NO_HISTORY, snapshotOf(first)), snapshotOf(second))

    const once = stepHistory(history, snapshotOf(third), 'undo')!
    expect(once.restored).toEqual(snapshotOf(second))
    expect(stepHistory(once.history, once.restored, 'undo')!.restored).toEqual(snapshotOf(first))
  })

  it('drops what could be redone on a new edit', () => {
    const before = emptyProject()
    const after = { ...before, definitions: {} }
    const undone = stepHistory(withEdit(NO_HISTORY, snapshotOf(before)), snapshotOf(after), 'undo')!
    expect(withEdit(undone.history, snapshotOf(before)).redo).toEqual([])
  })
})
