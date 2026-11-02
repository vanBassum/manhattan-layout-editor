import { describe, expect, it } from 'vitest'
import example from './examples/multivibrator.manhattan.json?raw'
import { buildProjectNetlist } from './definitions'
import { projectFromFile } from './projectStore'
import { pinEnds, projectSchematic, withPlacementChanges } from './schematic'

describe('withPlacementChanges', () => {
  it('moves a label on a moved pin to the new pin end, and gives it no other fields', () => {
    const project = projectFromFile(example)
    const built = buildProjectNetlist(project)
    const schematic = projectSchematic(project)
    const index = built.components.findIndex((c) => c.ref === 'R1')
    const placement = schematic.placements[index]
    const [end] = pinEnds(built.components[index], placement)
    const label = { x: end.x, y: end.y, name: 'TEST' }
    const moved = { ...placement, x: placement.x + 2.54 * 4 }
    const [newEnd] = pinEnds(built.components[index], moved)

    const after = withPlacementChanges({ ...schematic, labels: [...schematic.labels, label] }, built, [moved])

    expect(after.labels.at(-1)).toEqual({ x: newEnd.x, y: newEnd.y, name: 'TEST' })
  })
})
