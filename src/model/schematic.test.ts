import { describe, expect, it } from 'vitest'
import example from '../examples/Astable multivibrator.json?raw'
import { projectFromFile } from '../documents/projectFormat'
import { buildProjectNetlist } from './definitions'
import {
  alongDragAxis,
  deriveNets,
  draggedSchematic,
  flipped,
  flippedSelection,
  grabAt,
  labelDirection,
  labelsFromAgent,
  labelSymbolForName,
  marqueeSelection,
  pinEnds,
  pinsWithOtherNet,
  placedParts,
  projectSchematic,
  rotatedSelection,
  unconnectedPins,
  withLabelChanged,
  withPlacementChanges,
  withSchematicMoved,
  withTidyWires,
  type FullSchematic,
} from './schematic'
import { NO_WIRING } from './selection'
import type { BuiltNetlist, Netlist, Point, WiringSelection } from './types'

/** The example project's schematic with its part R1 and R1's first pin end. */
function exampleWithR1() {
  const project = projectFromFile(example)
  const built = buildProjectNetlist(project)
  const schematic = projectSchematic(project)
  const parts = placedParts(schematic.placements, built)
  const r1 = parts.find((p) => p.component.ref === 'R1')!
  return { built, schematic, parts, r1, pin: r1.pins[0] }
}

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
    const label = { x: end.x, y: end.y, name: 'TEST', symbol: 'net' as const }
    const moved = { ...placement, x: placement.x + 2.54 * 4 }
    const [newEnd] = pinEnds(built.components[index], moved)

    const after = withPlacementChanges({ ...schematic, labels: [...schematic.labels, label] }, built, [moved])

    expect(after.labels.at(-1)).toEqual({ x: newEnd.x, y: newEnd.y, name: 'TEST', symbol: 'net' })
  })
})

describe('deriveNets', () => {
  const project = projectFromFile(example)
  const built = buildProjectNetlist(project)
  const schematic = projectSchematic(project)

  it('matches pins by reference, whatever order the parts are in', () => {
    const inOrder = deriveNets(project.netlist, placedParts(schematic.placements, built), schematic)
    const reversed = deriveNets(project.netlist, placedParts([...schematic.placements].reverse(), built), schematic)

    expect(reversed.netlist).toEqual(inOrder.netlist)
  })

  it('refuses a netlist pin that is not placed', () => {
    const withoutR1 = schematic.placements.filter((p) => p.ref !== 'R1')

    expect(() => deriveNets(project.netlist, placedParts(withoutR1, built), schematic)).toThrow('R1.1 is not placed in the schematic')
  })
})

describe('withSchematicMoved', () => {
  const noParts: BuiltNetlist = { components: [], nets: [] }
  const move = (wiring: Partial<WiringSelection>, delta: Point, keepConnections = true) => ({
    placements: [],
    wiring: { ...NO_WIRING, ...wiring },
    delta,
    keepConnections,
  })

  it('stretches a wire along when its end moves along it', () => {
    const schematic: FullSchematic = { placements: [], wires: [{ x1: 0, y1: 0, x2: 10.16, y2: 0 }], labels: [] }

    const after = withSchematicMoved(schematic, noParts, move({ points: [{ x: 10.16, y: 0 }] }, { x: 5.08, y: 0 }))

    expect(after.wires).toEqual([{ x1: 0, y1: 0, x2: 15.24, y2: 0 }])
  })

  it('bends a wire whose end moves sideways into a Z, one grid step before the moved end', () => {
    const schematic: FullSchematic = { placements: [], wires: [{ x1: 0, y1: 0, x2: 10.16, y2: 0 }], labels: [] }

    const after = withSchematicMoved(schematic, noParts, move({ points: [{ x: 10.16, y: 0 }] }, { x: 0, y: 5.08 }))

    expect(after.wires).toEqual([
      { x1: 0, y1: 0, x2: 7.62, y2: 0 },
      { x1: 7.62, y1: 0, x2: 7.62, y2: 5.08 },
      { x1: 7.62, y1: 5.08, x2: 10.16, y2: 5.08 },
    ])
  })

  it('carries a wire whose two ends both move, with a label on its middle', () => {
    const schematic: FullSchematic = {
      placements: [],
      wires: [{ x1: 0, y1: 0, x2: 10.16, y2: 0 }],
      labels: [{ x: 5.08, y: 0, name: 'A', symbol: 'net' }],
    }
    const ends = [{ x: 0, y: 0 }, { x: 10.16, y: 0 }]

    const after = withSchematicMoved(schematic, noParts, move({ points: ends }, { x: 0, y: 2.54 }))

    expect(after.wires).toEqual([{ x1: 0, y1: 2.54, x2: 10.16, y2: 2.54 }])
    expect(after.labels).toEqual([{ x: 5.08, y: 2.54, name: 'A', symbol: 'net' }])
  })

  it('bridges the gap where a dragged wire leaves the middle of a wire that stays', () => {
    const schematic: FullSchematic = {
      placements: [],
      wires: [
        { x1: 0, y1: 0, x2: 20.32, y2: 0 },
        { x1: 10.16, y1: 0, x2: 10.16, y2: 10.16 },
      ],
      labels: [],
    }

    const dragged = withSchematicMoved(schematic, noParts, move({ wires: [1] }, { x: 5.08, y: 0 }))
    const moved = withSchematicMoved(schematic, noParts, move({ wires: [1] }, { x: 5.08, y: 0 }, false))

    expect(dragged.wires).toEqual([
      { x1: 0, y1: 0, x2: 20.32, y2: 0 },
      { x1: 15.24, y1: 0, x2: 15.24, y2: 10.16 },
      { x1: 10.16, y1: 0, x2: 15.24, y2: 0 },
    ])
    expect(moved.wires).toEqual(dragged.wires.slice(0, 2))
  })

  it('drags the wire on a moved part pin along, and bridges from a pin that stays', () => {
    const { built, schematic, r1, pin } = exampleWithR1()
    const outward = { x: pin.x + pin.dx * 5.08, y: pin.y + pin.dy * 5.08 }
    const withWire = { ...schematic, wires: [{ x1: pin.x, y1: pin.y, x2: outward.x, y2: outward.y }] }
    const delta = { x: pin.dx * 2.54, y: pin.dy * 2.54 }
    const moved = { ...r1.placement, x: r1.placement.x + delta.x, y: r1.placement.y + delta.y }

    const partDragged = withSchematicMoved(withWire, built, { placements: [moved], wiring: NO_WIRING, delta, keepConnections: true })
    const wireDragged = withSchematicMoved(withWire, built, move({ wires: [0] }, delta))

    expect(partDragged.wires).toEqual([{ x1: pin.x + delta.x, y1: pin.y + delta.y, x2: outward.x, y2: outward.y }])
    expect(wireDragged.wires).toEqual([
      { x1: pin.x + delta.x, y1: pin.y + delta.y, x2: outward.x + delta.x, y2: outward.y + delta.y },
      { x1: pin.x, y1: pin.y, x2: pin.x + delta.x, y2: pin.y + delta.y },
    ])
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
        { x: 0, y: 0, name: 'A', symbol: 'net' },
        { x: 15.24, y: 0, name: 'B', symbol: 'net' },
        { x: 30.48, y: 0, name: 'C', symbol: 'net' },
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
        { x: 0, y: 0, name: 'A', symbol: 'net' },
        { x: 5.08, y: 0, name: 'B', symbol: 'net' },
      ],
    }

    expect(withLabelChanged(schematic, 1, { name: 'C' }).labels).toEqual([
      { x: 0, y: 0, name: 'A', symbol: 'net' },
      { x: 5.08, y: 0, name: 'C', symbol: 'net' },
    ])
  })
})

describe('grabAt', () => {
  const wires = [{ x1: 0, y1: 0, x2: 10.16, y2: 0 }]

  it('finds the nearest wire end within the radius', () => {
    expect(grabAt(wires, [], { x: 9.5, y: 0.3 }, 1)).toEqual({ point: { x: 10.16, y: 0 }, onPin: false })
    expect(grabAt(wires, [], { x: 8, y: 0 }, 1)).toBeNull()
  })

  it('takes the pin over a wire end on the same spot', () => {
    const { parts, pin } = exampleWithR1()
    const onPin = [{ x1: pin.x, y1: pin.y, x2: pin.x + 50, y2: pin.y }]

    expect(grabAt(onPin, parts, { x: pin.x + 0.2, y: pin.y }, 1)).toEqual({ point: { x: pin.x, y: pin.y }, onPin: true })
  })
})

describe('marqueeSelection', () => {
  const schematic: FullSchematic = {
    placements: [],
    wires: [
      { x1: 0, y1: 0, x2: 5.08, y2: 0 },
      { x1: 5.08, y1: 0, x2: 20.32, y2: 0 },
    ],
    labels: [{ x: 2.54, y: 0, name: 'A', symbol: 'net' }],
  }
  const area = { x: -1, y: -1, w: 7, h: 2 }

  it('selects in a window what lies inside it, and the wire ends inside it as points', () => {
    expect(marqueeSelection(schematic, [], area, false)).toEqual({
      refs: [],
      wiring: { wires: [0], labels: [0], points: [{ x: 0, y: 0 }, { x: 5.08, y: 0 }] },
    })
  })

  it('selects crossing whatever it touches', () => {
    expect(marqueeSelection(schematic, [], area, true).wiring.wires).toEqual([0, 1])
  })

  it('selects a part by its pin ends with a margin, and leaves wire ends on its pins to the part', () => {
    const { schematic: example, parts, r1, pin } = exampleWithR1()
    const xs = r1.pins.map((p) => p.x)
    const ys = r1.pins.map((p) => p.y)
    const around = (margin: number) => ({
      x: Math.min(...xs) - margin,
      y: Math.min(...ys) - margin,
      w: Math.max(...xs) - Math.min(...xs) + 2 * margin,
      h: Math.max(...ys) - Math.min(...ys) + 2 * margin,
    })
    const withWire = { ...example, wires: [{ x1: pin.x, y1: pin.y, x2: pin.x, y2: pin.y + 100 }] }

    expect(marqueeSelection(withWire, parts, around(2.5), false).refs).toContain('R1')
    expect(marqueeSelection(withWire, parts, around(1), false).refs).not.toContain('R1')
    expect(marqueeSelection(withWire, parts, around(1), true).refs).toContain('R1')
    expect(marqueeSelection(withWire, parts, around(2.5), false).wiring.points).toEqual([])
  })
})

describe('alongDragAxis', () => {
  const base: FullSchematic = {
    placements: [],
    wires: [
      { x1: 0, y1: 0, x2: 10.16, y2: 0 },
      { x1: 0, y1: 0, x2: 0, y2: 10.16 },
    ],
    labels: [],
  }
  const wire = (index: number) => ({ kind: 'multi' as const, refs: [], nets: [], wiring: { ...NO_WIRING, wires: [index] } })
  const d = { x: 3, y: 4 }

  it('shifts a lone wire sideways only', () => {
    expect(alongDragAxis({ base, moving: wire(0), keepConnections: true }, d)).toEqual({ x: 0, y: 4 })
    expect(alongDragAxis({ base, moving: wire(1), keepConnections: true }, d)).toEqual({ x: 3, y: 0 })
  })

  it('lets a moved wire, or more than one wire, follow the pointer', () => {
    expect(alongDragAxis({ base, moving: wire(0), keepConnections: false }, d)).toEqual(d)
    const both = { kind: 'multi' as const, refs: [], nets: [], wiring: { ...NO_WIRING, wires: [0, 1] } }
    expect(alongDragAxis({ base, moving: both, keepConnections: true }, d)).toEqual(d)
  })
})

describe('draggedSchematic', () => {
  it('moves a part to the grid from where the drag started, keeping a rotation made since', () => {
    const { built, schematic, r1 } = exampleWithR1()
    const index = schematic.placements.indexOf(r1.placement)
    const rotated = { ...r1.placement, rotation: (r1.placement.rotation + 90) % 360 }
    const current = { ...schematic, placements: schematic.placements.map((p, i) => (i === index ? rotated : p)) }

    const after = draggedSchematic(current, built, { base: schematic, moving: { kind: 'part', ref: 'R1' }, keepConnections: true }, { x: 2.6, y: 0 })

    expect(after.placements[index]).toEqual({ ...rotated, x: r1.placement.x + 2.54, y: r1.placement.y })
  })
})

describe('labelDirection', () => {
  const wires = [{ x1: 0, y1: 0, x2: 10.16, y2: 0 }]

  it('points away from the pin the label sits on', () => {
    const { parts, pin } = exampleWithR1()

    expect(labelDirection(pin, parts, [])).toEqual({ x: pin.dx, y: pin.dy })
  })

  it('points up on a horizontal wire, and right anywhere else', () => {
    expect(labelDirection({ x: 5.08, y: 0 }, [], wires)).toEqual({ x: 0, y: -1 })
    expect(labelDirection({ x: 5.08, y: 2.54 }, [], wires)).toEqual({ x: 1, y: 0 })
  })
})

describe('labelSymbolForName', () => {
  it('suggests ground for ground nets, power for supply nets and a plain label otherwise', () => {
    expect(['GND', 'AGND', 'VCC', '+5V', '-12V', 'V+', 'OUT', 'B1'].map(labelSymbolForName)).toEqual([
      'ground',
      'ground',
      'power',
      'power',
      'power',
      'power',
      'net',
      'net',
    ])
  })
})

describe('labelsFromAgent', () => {
  it('gives a label without a symbol the one its name suggests, and keeps a given one', () => {
    const labels = labelsFromAgent([
      { x: 0, y: 0, name: 'GND' },
      { x: 0, y: 0, name: 'VCC', symbol: 'terminal' },
    ])

    expect(labels.map((l) => l.symbol)).toEqual(['ground', 'terminal'])
  })
})
