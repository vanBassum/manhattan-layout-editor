// What the editor draws of each part, and the footprints it stores, pinned down by snapshots so a
// change in how footprints are represented cannot change how parts look.

import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../documents/examples'
import { buildProjectNetlist, withDefinitions } from './definitions'
import { FOOTPRINT_LIBRARY } from './footprints'
import { analyzeLeads } from './layout'
import type { BuiltComponent, Project } from './types'

const drawn = (component: BuiltComponent) => {
  const { geometry } = component
  return {
    ref: component.ref,
    footprint: component.footprint,
    shape: geometry.shape,
    body: geometry.body,
    pins: component.pins.map((pin, k) => ({
      number: pin.number,
      anchor: { x: geometry.pins[k].x, y: geometry.pins[k].y },
      direction: { x: geometry.pins[k].dx, y: geometry.pins[k].dy },
    })),
    leadLength: geometry.leadLength,
    maxLeadLength: geometry.maxLeadLength,
    led: geometry.led === true,
    band: geometry.band === true,
  }
}

function drawnProject(project: Project) {
  const components = new Map(buildProjectNetlist(project).components.map((c) => [c.ref, c]))
  return project.layout.placements.map((placement) => {
    const component = components.get(placement.ref)!
    return { ...drawn(component), leads: analyzeLeads(component, placement, project.layout.islands, project.settings.isolation) }
  })
}

const REF_PREFIXES = { Resistors: 'R', Capacitors: 'C', Transistors: 'Q', Diodes: 'D', Other: 'X' }

const standIn = (ref: string, footprint: string, pinCount: number) => ({
  ref,
  value: '',
  footprint,
  pins: Array.from({ length: pinCount }, (_, n) => ({ number: String(n + 1), net: '' })),
})

/** Each library footprint on a stand-in part, and a few the library lacks: an LED, a DIP and a pin row. */
const libraryProject = (): Project => {
  const components = [
    ...FOOTPRINT_LIBRARY.map((f, k) => standIn(`${REF_PREFIXES[f.category]}${k + 1}`, f.id, f.pins)),
    standIn('LED1', 'LED-TH_BD5.0-P2.54', 2),
    standIn('U1', 'DIP-8_L9.8-W6.6-P2.54', 8),
    standIn('J1', 'HDR-3', 3),
  ]
  return {
    guid: 'library',
    netlist: { components, nets: [] },
    layout: { islands: [], placements: components.map((c) => ({ ref: c.ref, x: 0, y: 0, rotation: 0 })) },
    schematic: { placements: [], wires: [], labels: [] },
    settings: { snap: 0.5, isolation: 0.4, buildStyle: 'knife' },
  }
}

describe('drawn parts', () => {
  for (const example of EXAMPLES) {
    it(`of example "${example.name}" stay the same`, () => {
      const project = example.open()
      expect(drawnProject(project)).toMatchSnapshot('drawn')
      expect(withDefinitions(project).definitions).toMatchSnapshot('stored definitions')
    })
  }

  it('of every library footprint stay the same', () => {
    const project = libraryProject()
    expect(drawnProject(project)).toMatchSnapshot('drawn')
    expect(withDefinitions(project).definitions).toMatchSnapshot('stored definitions')
  })
})
