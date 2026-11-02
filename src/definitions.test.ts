import { describe, expect, it } from 'vitest'
import example from './examples/multivibrator.manhattan.json?raw'
import { buildNetlist, withDefinitions } from './definitions'
import type { ComponentDefinition, FootprintDefinition, NetComponent, Project, SymbolDefinition } from './types'

const SYMBOL: SymbolDefinition = {
  pins: [
    { number: '1', x: -5.08, y: 0, dx: -1, dy: 0 },
    { number: '2', x: 5.08, y: 0, dx: 1, dy: 0 },
  ],
  graphics: [{ type: 'rect', x: -2, y: -1, w: 4, h: 2, fill: 'power' }],
  label: { x: 0, y: -4 },
}

/** A footprint no heuristic would read from the name "R_AXIAL-0.4": a square SMD body. */
const ODD_FOOTPRINT: FootprintDefinition = {
  shape: 'smd',
  body: { x: -1, y: -1, w: 2, h: 2 },
  pins: [
    { number: '1', x: -1, y: 0, dx: -1, dy: 0 },
    { number: '2', x: 1, y: 0, dx: 1, dy: 0 },
  ],
  leadLength: 0,
  maxLeadLength: 0.5,
}

const resistor = (changes: Partial<NetComponent> = {}): NetComponent => ({
  ref: 'R1',
  value: '10k',
  footprint: 'R_AXIAL-0.4',
  pins: [
    { number: '1', net: 'A' },
    { number: '2', net: 'B' },
  ],
  ...changes,
})

const definition = (footprints: Record<string, FootprintDefinition>): ComponentDefinition => ({
  name: 'Power resistor',
  pins: [{ number: '1' }, { number: '2' }],
  symbol: SYMBOL,
  footprints,
})

const projectWith = (components: NetComponent[], definitions?: Record<string, ComponentDefinition>): Project => ({
  guid: 'test',
  name: 'Test',
  netlist: { components, nets: ['A', 'B'] },
  layout: { islands: [], placements: components.map((c) => ({ ref: c.ref, x: 0, y: 0, rotation: 0 })) },
  definitions,
  settings: { snap: 0.5, isolation: 0.4, strategy: 'knife', clearance: 3, maxLead: 10 },
})

const build = (project: Project) => buildNetlist(project.netlist, project.layout.placements, project.definitions)

/** What the editor draws of each part. */
const looks = (project: Project) =>
  build(project).components.map(({ ref, footprint, geometry, symbol }) => ({ ref, footprint, geometry, symbol }))

describe('buildNetlist', () => {
  it('takes geometry and symbol from the definition, not from the footprint name', () => {
    const project = projectWith([resistor({ definition: 'odd' })], { odd: definition({ 'R_AXIAL-0.4': ODD_FOOTPRINT }) })
    const [part] = build(project).components
    expect(part.geometry.shape).toBe('smd')
    expect(part.geometry.body).toEqual(ODD_FOOTPRINT.body)
    expect(part.symbol).toBe(SYMBOL)
  })

  it("uses the definition's footprint for a footprint chosen in the editor", () => {
    const project = projectWith([resistor({ definition: 'odd' })], {
      odd: definition({ 'R_AXIAL-0.4': ODD_FOOTPRINT, R1206: { ...ODD_FOOTPRINT, body: { x: -3, y: -1, w: 6, h: 2 } } }),
    })
    project.layout.placements[0].footprint = 'R1206'
    const [part] = build(project).components
    expect(part.footprint).toBe('R1206')
    expect(part.geometry.body).toEqual({ x: -3, y: -1, w: 6, h: 2 })
  })

  it("gives a part without a definition the project's definition for its template", () => {
    // The project customized its "resistor"; a part added since must look like that before any save.
    const project = projectWith([resistor()], { resistor: definition({ 'R_AXIAL-0.4': ODD_FOOTPRINT }) })
    const [part] = build(project).components
    expect(part.symbol).toBe(SYMBOL)
    expect(part.geometry.body).toEqual(ODD_FOOTPRINT.body)
  })

  it('falls back to the template for a definition footprint that lacks one of the pins', () => {
    const onePin = { ...ODD_FOOTPRINT, pins: [ODD_FOOTPRINT.pins[0]] }
    const project = projectWith([resistor({ definition: 'odd' })], { odd: definition({ 'R_AXIAL-0.4': onePin }) })
    const [part] = build(project).components
    expect(part.geometry.anchors).toHaveLength(2)
    expect(part.geometry.shape).toBe('axial')
  })
})

describe('withDefinitions', () => {
  it('stores what buildNetlist already showed', () => {
    const project = projectWith([resistor(), resistor({ ref: 'C1', footprint: 'CAP-TH_BD5.0-P2.00' })], {
      resistor: definition({ 'R_AXIAL-0.4': ODD_FOOTPRINT }),
    })
    project.layout.placements[0].footprint = 'R1206'
    expect(looks(withDefinitions(project))).toEqual(looks(project))
  })

  it('keeps every part of the example as it was, with or without stored definitions', () => {
    const stored = (JSON.parse(example) as { project: Project }).project
    const withoutDefinitions: Project = {
      ...stored,
      netlist: { ...stored.netlist, components: stored.netlist.components.map(({ definition: _, ...c }) => c) },
      definitions: undefined,
    }
    expect(looks(withDefinitions(withoutDefinitions))).toEqual(looks(withoutDefinitions))
    expect(looks(withDefinitions(stored))).toEqual(looks(stored))
  })
})
