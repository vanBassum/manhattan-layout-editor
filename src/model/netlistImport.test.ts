import { describe, expect, it } from 'vitest'
import { importedProject, reimportedProject } from './netlistImport'
import { pinsWithOtherNet, projectSchematicNets } from './schematic'
import type { Project } from './types'

const SETTINGS = { snap: 1, isolation: 0.5, buildStyle: 'manhattan' as const }

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

describe('importing a netlist', () => {
  it('starts over on a fresh grid with the given settings, keeping only the guid', () => {
    const imported = importedProject(netlistText({ R1: { value: '10k', nets: ['A', 'B'] } }), 'kept-guid', SETTINGS)

    expect(imported.guid).toBe('kept-guid')
    expect(imported.settings).toEqual(SETTINGS)
    expect(imported.layout.placements.map((p) => p.ref)).toEqual(['R1'])
    expect(imported.layout.islands.map((i) => i.net)).toEqual(['A', 'B'])
    expect(imported.definitions?.[imported.netlist.components[0].definition!]).toBeDefined()
  })

  it('starts the schematic with every part placed and every connected pin labelled with its net', () => {
    const imported = importedProject(netlistText({ R1: { value: '10k', nets: ['A', 'GND'] }, R2: { value: '1k', nets: ['A', ''] } }), 'g', SETTINGS)

    expect(imported.schematic.placements.map((p) => p.ref)).toEqual(['R1', 'R2'])
    expect(imported.schematic.wires).toEqual([])
    expect(imported.schematic.labels.map((l) => [l.name, l.symbol])).toEqual([
      ['A', 'net'],
      ['GND', 'ground'],
      ['A', 'net'],
    ])
    expect(pinsWithOtherNet(imported.netlist, projectSchematicNets(imported).netlist)).toEqual([])
  })

  it('keeps where the symbols were on a re-import, and starts wires and labels over from the new nets', () => {
    const current = importedProject(netlistText({ R1: { value: '10k', nets: ['A', 'B'] } }), 'guid', SETTINGS)
    const moved = { ...current.schematic.placements[0], x: 50.8, y: 25.4 }
    const edited: Project = {
      ...current,
      schematic: { placements: [moved], wires: [{ x1: 0, y1: 0, x2: 2.54, y2: 0 }], labels: [{ x: 0, y: 0, name: 'OLD', symbol: 'net' }] },
    }

    const reimported = reimportedProject(netlistText({ R1: { value: '10k', nets: ['A', 'C'] }, R2: { value: '1k', nets: ['C', 'D'] } }), edited)

    expect(reimported.schematic.placements.map((p) => p.ref)).toEqual(['R1', 'R2'])
    expect(reimported.schematic.placements[0]).toEqual(moved)
    expect(reimported.schematic.wires).toEqual([])
    expect(reimported.schematic.labels.map((l) => l.name)).toEqual(['A', 'C', 'C', 'D'])
    expect(pinsWithOtherNet(reimported.netlist, projectSchematicNets(reimported).netlist)).toEqual([])
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
    const imported = importedProject(netlistText({ R1: { value: '10k', nets: ['A', 'B'] }, R2: { value: '10k', nets: ['A', 'B'] } }), 'guid', SETTINGS)
    const template = imported.definitions![imported.netlist.components[0].definition!]
    const current: Project = {
      ...imported,
      netlist: { ...imported.netlist, components: imported.netlist.components.map((c) => ({ ...c, definition: 'power' })) },
      definitions: { power: template },
    }

    const reimported = reimportedProject(
      netlistText({ R1: { value: '10k', nets: ['A', 'B', 'C'] }, R2: { value: '10k', nets: ['A', 'B'] } }),
      current,
    )

    const [r1, r2] = reimported.netlist.components
    expect(r1.definition).not.toBe('power')
    expect(r2.definition).toBe('power')
  })

  it('keeps the footprint chosen for a part, unless its pin count no longer fits a library footprint', () => {
    const imported = importedProject(
      netlistText({ R1: { value: '1k', nets: ['A', 'B'] }, R2: { value: '1k', nets: ['A', 'B'] }, R3: { value: '1k', nets: ['A', 'B'] } }),
      'guid',
      SETTINGS,
    )
    const choices: Record<string, string> = { R1: 'R1206', R2: 'R1206', R3: 'MY-OWN-PACKAGE' }
    const current: Project = {
      ...imported,
      netlist: { ...imported.netlist, components: imported.netlist.components.map((c) => ({ ...c, chosenFootprint: choices[c.ref] })) },
    }

    const reimported = reimportedProject(
      netlistText({ R1: { value: '1k', nets: ['A', 'B'] }, R2: { value: '1k', nets: ['A', 'B', 'C'] }, R3: { value: '1k', nets: ['A', 'B', 'C'] } }),
      current,
    )

    // R2 has three pins now, which the two-pin R1206 does not fit; R3's own package cannot be checked.
    expect(reimported.netlist.components.map((c) => c.chosenFootprint)).toEqual(['R1206', undefined, 'MY-OWN-PACKAGE'])
  })
})
