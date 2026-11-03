import { describe, expect, it } from 'vitest'
import example from './examples/Astable multivibrator.manhattan.json?raw'
import {
  buildNetlist,
  checkedDefinition,
  checkedDefinitions,
  importedProject,
  reimportedProject,
  withDefinitions,
  withoutUnfitDefinitions,
} from './definitions'
import { EXAMPLES } from './documents/examples'
import { projectFromFile } from './documents/projectFormat'
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

  it('refuses a definition footprint that lacks one of the pins instead of drawing another one', () => {
    const onePin = { ...ODD_FOOTPRINT, pins: [ODD_FOOTPRINT.pins[0]] }
    const project = projectWith([resistor({ definition: 'odd' })], { odd: definition({ 'R_AXIAL-0.4': onePin }) })
    expect(() => build(project)).toThrow('lacks some of its pins')
  })

  it('refuses a definition that does not exist or lacks the part\'s pins, instead of drawing a template', () => {
    expect(() => build(projectWith([resistor({ definition: 'gone' })], {}))).toThrow('R1: definition "gone" does not exist')
    const threePins = resistor({ definition: 'odd', pins: [...resistor().pins, { number: '3', net: 'A' }] })
    expect(() => build(projectWith([threePins], { odd: definition({ 'R_AXIAL-0.4': ODD_FOOTPRINT }) }))).toThrow(
      'R1: definition "odd" lacks some of its pins',
    )
  })
})

describe('withoutUnfitDefinitions', () => {
  it("drops only a definition that lacks the part's pins, as after a re-import that changed them", () => {
    const definitions = { odd: definition({ 'R_AXIAL-0.4': ODD_FOOTPRINT }) }
    const changedPins = resistor({ definition: 'odd', pins: [...resistor().pins, { number: '3', net: 'A' }] })
    const missing = resistor({ ref: 'R2', definition: 'gone' })
    const fitting = resistor({ ref: 'R3', definition: 'odd' })
    const netlist = withoutUnfitDefinitions({ components: [changedPins, missing, fitting], nets: ['A', 'B'] }, definitions)
    expect(netlist.components.map((c) => c.definition)).toEqual([undefined, 'gone', 'odd'])
  })
})

describe('projectFromFile', () => {
  it('opens every example, and builds its netlist', () => {
    expect(EXAMPLES.length).toBeGreaterThan(0)
    for (const example of EXAMPLES) expect(() => build(example.open())).not.toThrow()
  })

  it('refuses a part referring to a definition the file does not have', () => {
    const project = projectWith([resistor({ definition: 'gone' })], {})
    const file = JSON.stringify({ format: 'manhattan-layout-editor', version: 7, project })
    expect(() => projectFromFile(file)).toThrow('R1: definition "gone" does not exist')
  })

  it('refuses an unknown optimizer strategy', () => {
    const project = { ...projectWith([resistor()]), settings: { ...projectWith([]).settings, strategy: 'teleport' } }
    const file = JSON.stringify({ format: 'manhattan-layout-editor', version: 7, project })
    expect(() => projectFromFile(file)).toThrow('Unknown strategy "teleport"')
  })
})

describe('diode footprints', () => {
  it('mark the cathode (pin 1) with a band, and keep it through a saved definition', () => {
    const diode: NetComponent = { ref: 'D1', value: '1N4148', footprint: 'DO-35_BD1.9-L3.8-P7.62', pins: [{ number: '1', net: 'A' }, { number: '2', net: 'B' }] }
    const project = projectWith([diode])
    expect(build(project).components[0].geometry.band).toBe(true)
    expect(build(withDefinitions(project)).components[0].geometry.band).toBe(true)
    expect(build(projectWith([resistor()])).components[0].geometry.band).toBe(false)
  })
})

describe('checkedDefinition', () => {
  it('refuses a footprint without every pin of the symbol', () => {
    const onePin = { ...ODD_FOOTPRINT, pins: [ODD_FOOTPRINT.pins[0]] }
    expect(() => checkedDefinition(definition({ 'R_AXIAL-0.4': onePin }))).toThrow('footprint "R_AXIAL-0.4" has no pin 2')
    expect(checkedDefinition(definition({ 'R_AXIAL-0.4': ODD_FOOTPRINT }))).toBeTruthy()
  })

  it('names the definition at fault in a project file', () => {
    const onePin = { ...ODD_FOOTPRINT, pins: [ODD_FOOTPRINT.pins[0]] }
    const project = projectWith([resistor({ definition: 'odd' })], { odd: definition({ 'R_AXIAL-0.4': onePin }) })
    const file = JSON.stringify({ format: 'manhattan-layout-editor', version: 6, project })
    expect(() => projectFromFile(file)).toThrow('definition "odd": footprint "R_AXIAL-0.4" has no pin 2')
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

  it("makes a template footprint for every pin of the definition's symbol, so it passes the check", () => {
    // A two-pin part on a definition whose symbol has a third pin.
    const threePins: ComponentDefinition = {
      ...definition({}),
      pins: [{ number: '1' }, { number: '2' }, { number: '3' }],
      symbol: { ...SYMBOL, pins: [...SYMBOL.pins, { number: '3', x: 0, y: 5.08, dx: 0, dy: 1 }] },
    }
    const project = projectWith([resistor({ definition: 'three' })], { three: threePins })
    const saved = withDefinitions(project)
    expect(saved.definitions!.three.footprints['R_AXIAL-0.4'].pins.map((p) => p.number)).toEqual(['1', '2', '3'])
    expect(() => checkedDefinitions(saved.definitions)).not.toThrow()
    expect(looks(saved)).toEqual(looks(project))
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

describe('importing a netlist', () => {
  const SETTINGS = { snap: 1, isolation: 0.5, strategy: 'manhattan' as const, clearance: 2, maxLead: 8 }
  /** An EasyEDA netlist with one part per entry of `parts`: its value and the net of each pin. */
  const netlistText = (parts: Record<string, { value: string; nets: string[] }>) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(parts).map(([ref, { value, nets }]) => [
          ref,
          { props: { designator: ref, value, footprint: 'R_AXIAL-0.4' }, pins: Object.fromEntries(nets.map((net, k) => [String(k + 1), net])) },
        ]),
      ),
    )

  it('starts over on a fresh grid with the given settings, keeping only the guid', () => {
    const imported = importedProject(netlistText({ R1: { value: '10k', nets: ['A', 'B'] } }), 'kept-guid', SETTINGS)

    expect(imported.guid).toBe('kept-guid')
    expect(imported.settings).toEqual(SETTINGS)
    expect(imported.schematic).toBeUndefined()
    expect(imported.layout.placements.map((p) => p.ref)).toEqual(['R1'])
    expect(imported.layout.islands.map((i) => i.net)).toEqual(['A', 'B'])
    expect(imported.definitions?.[imported.netlist.components[0].definition!]).toBeDefined()
  })

  it('keeps a value typed in the editor that the new netlist leaves empty, and where the part was', () => {
    const current = importedProject(netlistText({ R1: { value: '10k', nets: ['A', 'B'] } }), 'guid', SETTINGS)
    const moved = { ...current, layout: { ...current.layout, placements: [{ ...current.layout.placements[0], x: 42, y: 7 }] } }

    const reimported = reimportedProject(netlistText({ R1: { value: '', nets: ['A', 'B'] }, R2: { value: '1k', nets: ['B', 'C'] } }), moved)

    expect(reimported.netlist.components.map((c) => c.value)).toEqual(['10k', '1k'])
    expect(reimported.layout.placements.find((p) => p.ref === 'R1')).toMatchObject({ x: 42, y: 7 })
    expect(reimported.settings).toEqual(SETTINGS)
  })

  it("drops a part's definition when its pins changed, and keeps it while they fit", () => {
    const current = projectWith([resistor({ definition: 'power' }), resistor({ ref: 'R2', definition: 'power' })], { power: definition({}) })

    const reimported = reimportedProject(
      netlistText({ R1: { value: '10k', nets: ['A', 'B', 'C'] }, R2: { value: '10k', nets: ['A', 'B'] } }),
      current,
    )

    const [r1, r2] = reimported.netlist.components
    expect(r1.definition).not.toBe('power')
    expect(r2.definition).toBe('power')
  })
})
