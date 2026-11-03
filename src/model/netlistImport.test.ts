import { describe, expect, it } from 'vitest'
import { importedProject, reimportedProject } from './netlistImport'
import type { Project } from './types'

const SETTINGS = { snap: 1, isolation: 0.5, buildStyle: 'manhattan' as const, placement: 'schematic' as const, clearance: 2, maxLead: 8 }

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
})
