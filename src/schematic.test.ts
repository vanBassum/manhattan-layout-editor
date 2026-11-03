import { describe, expect, it } from 'vitest'
import example from './examples/Astable multivibrator.manhattan.json?raw'
import { buildProjectNetlist } from './definitions'
import { projectFromFile } from './documents/projectFormat'
import {
  flipped,
  flippedSelection,
  pinEnds,
  pinsWithOtherNet,
  projectSchematic,
  rotatedSelection,
  unconnectedPins,
  withLabelChanged,
  withPlacementChanges,
  withTidyWires,
  type FullSchematic,
} from './schematic'
import type { BuiltNetlist, Netlist } from './types'

describe('pinsWithOtherNet', () => {
  const netlist = (nets: Record<string, string>): Netlist => ({
    components: [
      { ref: 'R1', value: '1k', footprint: '', pins: [{ number: '1', net: nets['R1.1'] }, { number: '2', net: nets['R1.2'] }] },
      { ref: 'R2', value: '1k', footprint: '', pins: [{ number: '1', net: nets['R2.1'] }, { number: '2', net: nets['R2.2'] }] },
    ],
    nets: [...new Set(Object.values(nets))],
  })

  it('ignores a net that is only renamed', () => {
    const pcb = netlist({ 'R1.1': 'A', 'R1.2': 'MID', 'R2.1': 'MID', 'R2.2': 'B' })
    const schematic = netlist({ 'R1.1': 'IN', 'R1.2': 'R1.2', 'R2.1': 'R1.2', 'R2.2': 'OUT' })

    expect(pinsWithOtherNet(pcb, schematic)).toEqual([])
  })

  it('lists the pins whose connections changed', () => {
    const pcb = netlist({ 'R1.1': 'A', 'R1.2': 'MID', 'R2.1': 'MID', 'R2.2': 'B' })
    const schematic = netlist({ 'R1.1': 'A', 'R1.2': 'MID', 'R2.1': 'B', 'R2.2': 'B' })

    expect(pinsWithOtherNet(pcb, schematic)).toEqual(['R1.2', 'R2.1', 'R2.2'])
  })
})

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

describe('withTidyWires', () => {
  const noParts: BuiltNetlist = { components: [], nets: [] }
  const wiresOnly = (wires: FullSchematic['wires'], labels: FullSchematic['labels'] = []): FullSchematic => ({ placements: [], wires, labels })

  it('splits wires lying over each other into pieces that meet end to end', () => {
    const schematic = wiresOnly([
      { x1: 0, y1: 0, x2: 10.16, y2: 0 },
      { x1: 5.08, y1: 0, x2: 15.24, y2: 0 },
    ])

    const { schematic: tidy, selectedWires } = withTidyWires(schematic, noParts, [1])

    expect(tidy.wires).toEqual([
      { x1: 0, y1: 0, x2: 5.08, y2: 0 },
      { x1: 5.08, y1: 0, x2: 10.16, y2: 0 },
      { x1: 10.16, y1: 0, x2: 15.24, y2: 0 },
    ])
    expect(selectedWires).toEqual([1, 2])
  })

  it('removes a wire folded back on itself, and a stub left loose, but keeps ends that were loose before', () => {
    const schematic = wiresOnly(
      [
        // From label A to label B, then folded back past B to a loose end at 15.24.
        { x1: 0, y1: 0, x2: 20.32, y2: 0 },
        { x1: 20.32, y1: 0, x2: 15.24, y2: 0 },
        // A stub hanging off A.
        { x1: 0, y1: 0, x2: 0, y2: 5.08 },
        // A wire someone left loose on purpose.
        { x1: 30.48, y1: 0, x2: 30.48, y2: 5.08 },
      ],
      [
        { x: 0, y: 0, name: 'A' },
        { x: 15.24, y: 0, name: 'B' },
        { x: 30.48, y: 0, name: 'C' },
      ],
    )

    const { schematic: tidy } = withTidyWires(schematic, noParts, [], [{ x: 30.48, y: 5.08 }])

    expect(tidy.wires).toEqual([
      { x1: 0, y1: 0, x2: 15.24, y2: 0 },
      { x1: 30.48, y1: 0, x2: 30.48, y2: 5.08 },
    ])
  })

  it('takes float noise off wire ends, so wires that should line up do', () => {
    const schematic = wiresOnly([
      { x1: 0, y1: 22.860000000000003, x2: 5.08, y2: 22.86 },
      { x1: 5.08, y1: 22.86, x2: 10.16, y2: 22.86 },
    ])

    const { schematic: tidy, changed } = withTidyWires(schematic, noParts, [])

    expect(changed).toBe(true)
    expect(tidy.wires).toEqual([
      { x1: 0, y1: 22.86, x2: 5.08, y2: 22.86 },
      { x1: 5.08, y1: 22.86, x2: 10.16, y2: 22.86 },
    ])
  })
})

describe('unconnectedPins', () => {
  it('lists the pins on no net', () => {
    const netlist: Netlist = {
      components: [{ ref: 'R1', value: '1k', footprint: '', pins: [{ number: '1', net: 'A' }, { number: '2', net: '' }] }],
      nets: ['A'],
    }

    expect(unconnectedPins(netlist)).toEqual(['R1.2'])
  })
})

describe('turning the selection', () => {
  const project = projectFromFile(example)
  const built = buildProjectNetlist(project)
  const exampleSchematic = projectSchematic(project)
  const r1 = built.components.findIndex((c) => c.ref === 'R1')
  // Two ground symbols away from every pin, one of them already turned.
  const schematic: FullSchematic = {
    ...exampleSchematic,
    labels: [
      ...exampleSchematic.labels,
      { x: -100, y: -100, name: 'GND', symbol: 'ground' },
      { x: -200, y: -100, name: 'GND', symbol: 'ground', rotation: 90 },
    ],
  }
  const [straight, turned] = [schematic.labels.length - 2, schematic.labels.length - 1]
  const rotations = (s: FullSchematic) => [s.labels[straight].rotation, s.labels[turned].rotation]

  it('rotates a part and labels by quarter turns, rounding to at least one', () => {
    const after = rotatedSelection(schematic, built, ['R1'], [straight, turned], 15)

    expect(after.placements[r1].rotation).toBe((schematic.placements[r1].rotation + 90) % 360)
    expect(rotations(after)).toEqual([90, 180])
    expect(after.placements.filter((_, i) => i !== r1)).toEqual(schematic.placements.filter((_, i) => i !== r1))
  })

  it('takes a label past a full turn back to 0', () => {
    const after = rotatedSelection(schematic, built, [], [turned], 270)

    expect(after.labels[turned].rotation).toBe(0)
    expect(after.labels[straight]).toEqual(schematic.labels[straight])
  })

  it('mirrors a part, and points a label the mirrored way', () => {
    const horizontal = flippedSelection(schematic, built, ['R1'], [straight, turned], 'horizontal')
    const vertical = flippedSelection(schematic, built, ['R1'], [straight, turned], 'vertical')

    expect(horizontal.placements[r1]).toEqual(flipped(schematic.placements[r1], 'horizontal'))
    expect(vertical.placements[r1]).toEqual(flipped(schematic.placements[r1], 'vertical'))
    expect(rotations(horizontal)).toEqual([0, 270])
    expect(rotations(vertical)).toEqual([180, 90])
  })
})

describe('withLabelChanged', () => {
  it('changes only the given label', () => {
    const schematic: FullSchematic = {
      placements: [],
      wires: [],
      labels: [
        { x: 0, y: 0, name: 'A' },
        { x: 5.08, y: 0, name: 'B' },
      ],
    }

    expect(withLabelChanged(schematic, 1, { name: 'C' }).labels).toEqual([
      { x: 0, y: 0, name: 'A' },
      { x: 5.08, y: 0, name: 'C' },
    ])
  })
})
