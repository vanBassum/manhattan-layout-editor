import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../documents/projectFormat'
import { buildNetlist } from '../model/definitions'
import { rectsOverlap } from '../model/geometry'
import type { SchematicPlacement } from '../model/types'
import { placeFromSchematic } from './fromSchematic'

const resistor = (ref: string, footprint: string, nets: [string, string]) => ({
  ref,
  value: '1k',
  footprint,
  pins: [
    { number: '1', net: nets[0] },
    { number: '2', net: nets[1] },
  ],
})

const netlist = (footprint: string) =>
  buildNetlist({ components: [resistor('R1', footprint, ['A', 'B']), resistor('R2', footprint, ['B', 'C'])], nets: ['A', 'B', 'C'] }, [], undefined)

const placeAt = (footprint: string, placements: SchematicPlacement[]) =>
  placeFromSchematic(netlist(footprint), DEFAULT_SETTINGS, { placements, wires: [], labels: [] })

const partOf = (parts: ReturnType<typeof placeAt>, ref: string) => parts.find((p) => p.component.ref === ref)!

describe('placeFromSchematic', () => {
  it('keeps parts drawn side by side in the same left/right order, pushed clear of each other', () => {
    // Drawn so close that their keep-outs overlap on the board.
    for (const [left, right] of [['R1', 'R2'], ['R2', 'R1']]) {
      const parts = placeAt('R_AXIAL-0.4', [
        { ref: left, x: 0, y: 0, rotation: 0 },
        { ref: right, x: 5.08, y: 0, rotation: 0 },
      ])
      expect(partOf(parts, left).placement.x).toBeLessThan(partOf(parts, right).placement.x)
      expect(rectsOverlap(parts[0].keepOut, parts[1].keepOut)).toBe(false)
    }
  })

  it('leaves parts that are drawn far enough apart where they are drawn', () => {
    const parts = placeAt('R_AXIAL-0.4', [
      { ref: 'R1', x: 0, y: 0, rotation: 0 },
      { ref: 'R2', x: 0, y: 20.32, rotation: 0 },
    ])
    expect(parts.map((p) => [p.placement.x, p.placement.y])).toEqual([
      [0, 0],
      [0, 20.5],
    ])
  })

  it('turns a part a quarter turn when its symbol is drawn upright, with its leads pointing where the pins do', () => {
    const parts = placeAt('R_AXIAL-0.4', [
      { ref: 'R1', x: 0, y: 0, rotation: 90 },
      { ref: 'R2', x: 30.48, y: 0, rotation: 270 },
    ])
    const [r1, r2] = parts
    expect([r1.placement.rotation, r2.placement.rotation]).toEqual([90, 270])
    // Pin 1 at the top for R1, at the bottom for R2, as in the schematic.
    expect(r1.ends[0].y).toBeLessThan(r1.ends[1].y)
    expect(r2.ends[0].y).toBeGreaterThan(r2.ends[1].y)
  })

  it('refuses a part the schematic does not have', () => {
    expect(() => placeAt('R1206', [{ ref: 'R1', x: 0, y: 0, rotation: 0 }])).toThrow('R2 is not in the schematic')
  })
})
