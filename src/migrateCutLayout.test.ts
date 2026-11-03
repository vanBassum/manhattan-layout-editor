import { describe, expect, it } from 'vitest'
import { withoutCutLines } from './migrateCutLayout'
import type { Layout, Project, Settings } from './types'

const SETTINGS: Settings = { snap: 0.5, isolation: 0.4, strategy: 'knife', clearance: 1, maxLead: 10 }

/** R1 lies across a board cut at x = 10 and x = 18; its leads end at x = 4.92 and x = 15.08. */
const cutLineProject = (): Project => ({
  guid: 'g',
  netlist: {
    components: [{ ref: 'R1', value: '1k', footprint: 'R_AXIAL-0.4', pins: [{ number: '1', net: 'A' }, { number: '2', net: 'B' }] }],
    nets: ['A', 'B'],
  },
  layout: {
    islands: [],
    placements: [{ ref: 'R1', x: 10, y: 5, rotation: 0 }],
    knife: {
      board: { x: 0, y: 0, w: 20, h: 10 },
      cuts: [
        { x1: 10, y1: 0, x2: 10, y2: 10 },
        { x1: 18, y1: 10, x2: 18, y2: 0 },
      ],
    },
    freeCopper: [],
  } as Layout,
  settings: { ...SETTINGS, strategy: 'knife-cuts' } as unknown as Settings,
})

describe('withoutCutLines', () => {
  it('turns the pieces the cuts made into islands of the nets whose leads end there, leaving out copper no lead reaches', () => {
    const migrated = withoutCutLines(cutLineProject())

    expect(migrated.settings.strategy).toBe('knife')
    expect(migrated.layout).toEqual({
      islands: [
        { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 10 }] },
        { net: 'B', rects: [{ x: 10, y: 0, w: 8, h: 10 }] },
      ],
      placements: [{ ref: 'R1', x: 10, y: 5, rotation: 0 }],
    })
  })

  it('leaves a layout without cut lines alone', () => {
    const project: Project = { ...cutLineProject(), layout: { islands: [], placements: [] }, settings: SETTINGS }

    expect(withoutCutLines(project)).toEqual(project)
  })
})
