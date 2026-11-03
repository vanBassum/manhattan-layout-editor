import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../documents/examples'
import { DEFAULT_SETTINGS } from '../documents/projectFormat'
import { buildNetlist, buildProjectNetlist } from '../model/definitions'
import { inflate, rectsOverlap } from '../model/geometry'
import { analyzeLeads, bodyBounds, defaultLeadEnds, findSpacingViolations, findSplitNets } from '../model/layout'
import { isRealNet } from '../model/netlist'
import { completeSchematic, projectSchematic, type FullSchematic } from '../model/schematic'
import type { BuiltNetlist, Layout, NetComponent, Settings } from '../model/types'
import { BUILD_STYLES, optimizedLayout } from './index'

const part = (ref: string, value: string, footprint: string, nets: string[]): NetComponent => ({
  ref,
  value,
  footprint,
  pins: nets.map((net, k) => ({ number: String(k + 1), net })),
})

/** A 555 blinker: unlike the examples it has a DIP part, a pin on no net and SMD parts on ground. */
const BLINKER_COMPONENTS = [
  part('U1', 'NE555', 'DIP-8', ['GND', 'TRIG', 'OUT', 'VCC', 'CTRL', 'TRIG', 'DIS', 'VCC']),
  part('R1', '1k', 'R_AXIAL-0.4', ['VCC', 'DIS']),
  part('R2', '10k', 'R_AXIAL-0.4', ['DIS', 'TRIG']),
  part('C1', '10uF', 'CAP-TH_BD5.0-P2.00', ['TRIG', 'GND']),
  part('C2', '10nF', 'C0805', ['CTRL', 'GND']),
  part('R3', '470', 'R1206', ['OUT', 'LED_A']),
  part('D1', 'LED', 'LED-TH_RADIAL_BD5.0-P2.54', ['LED_A', 'GND']),
  part('RV1', '10k', 'RES-ADJ-TH_3296W_L9.5-W4.8-P2.54', ['VCC', 'DIS', '']),
]
const BLINKER_NETS = ['CTRL', 'DIS', 'GND', 'LED_A', 'OUT', 'TRIG', 'VCC']

const blinker = buildNetlist({ components: BLINKER_COMPONENTS, nets: BLINKER_NETS }, [], undefined)

const inputs: { name: string; netlist: BuiltNetlist; settings: Settings; schematic: FullSchematic }[] = [
  ...EXAMPLES.map((example) => {
    const project = example.open()
    return { name: example.name, netlist: buildProjectNetlist(project), settings: project.settings, schematic: projectSchematic(project) }
  }),
  // No schematic drawn: the parts sit on the grid completeSchematic puts them on.
  { name: '555 blinker', netlist: blinker, settings: DEFAULT_SETTINGS, schematic: completeSchematic(blinker, undefined) },
]

describe.each(inputs)('$name', ({ netlist, settings, schematic }) => {
  describe.each(BUILD_STYLES)('$id', (buildStyle) => {
    const layout: Layout = optimizedLayout(netlist, { ...settings, buildStyle: buildStyle.id, placement: 'schematic' }, schematic)
    const componentOf = (ref: string) => netlist.components.find((c) => c.ref === ref)!

    it('places every part', () => {
      expect(layout.placements.map((p) => p.ref).sort()).toEqual(netlist.components.map((c) => c.ref).sort())
    })

    it('keeps the parts and their unbent leads clear of each other', () => {
      const keepOuts = layout.placements.map((p) => {
        const { geometry } = componentOf(p.ref)
        return { ref: p.ref, rect: inflate(bodyBounds(geometry, p, defaultLeadEnds(geometry)), settings.clearance / 2) }
      })
      const overlapping = keepOuts.flatMap((a, k) =>
        keepOuts.slice(k + 1).flatMap((b) => (rectsOverlap(a.rect, b.rect) ? [`${a.ref}/${b.ref}`] : [])),
      )
      expect(overlapping).toEqual([])
    })

    // A pin on no net is left alone: on Manhattan's ground plane it touches copper and reads as a short.
    it('lands every lead of a net on that net, and on nothing else', () => {
      const wrong = layout.placements.flatMap((p) =>
        analyzeLeads(componentOf(p.ref), p, layout.islands, settings.isolation)
          .filter((lead) => isRealNet(lead.net) && lead.status !== 'ok')
          .map((lead) => `${p.ref}:${lead.net}:${lead.status}`),
      )
      expect(wrong).toEqual([])
    })

    it('gives every net an island', () => {
      expect(netlist.nets.filter((net) => !layout.islands.some((i) => i.net === net))).toEqual([])
    })

    // Islands that touch are fine: the isolation is burned centred on their shared edge.
    it('keeps islands of different nets from overlapping, each in one piece', () => {
      expect([...findSpacingViolations(layout.islands)]).toEqual([])
      expect([...findSplitNets(layout.islands)]).toEqual([])
    })
  })
})
