import { describe, expect, it } from 'vitest'
import example from '../examples/Astable multivibrator.json?raw'
import { checkedProject, projectFileName, projectFromFile, projectNameOf, projectToFile, readSavedProject } from './projectFormat'
import { pinsWithOtherNet, projectSchematicNets } from '../model/schematic'
import type { Project } from '../model/types'

describe('projectFromFile', () => {
  it('drops the name older files stored: a project is called by its file name', () => {
    expect(JSON.parse(example).project.name).toBe('Astable multivibrator')
    expect(projectFromFile(example)).not.toHaveProperty('name')
    expect(JSON.parse(projectToFile(projectFromFile(example))).project).not.toHaveProperty('name')
  })
})

describe('checkedProject simulation', () => {
  const stored = JSON.parse(example).project

  it('keeps supplies and models through a save', () => {
    const simulation = { supplies: [{ net: 'VCC', volts: 9 }], models: { BC547: '.model BC547 NPN(BF=300)' } }
    const saved = projectFromFile(projectToFile(checkedProject({ ...stored, simulation })))
    expect(saved.simulation).toEqual(simulation)
  })

  it('leaves it out of a project without one', () => {
    expect(checkedProject(stored)).not.toHaveProperty('simulation')
  })

  it('refuses a supply without a number of volts', () => {
    expect(() => checkedProject({ ...stored, simulation: { supplies: [{ net: 'VCC', volts: '9' }], models: {} } })).toThrow(
      'simulation "supplies" must be a list of {net, volts}',
    )
  })
})

describe('checkedProject settings', () => {
  const stored = JSON.parse(example).project
  const settingsOf = (settings: object) => checkedProject({ ...stored, settings }).settings

  it('turns the strategy of files before v8 into a build style', () => {
    expect(stored.settings.strategy).toBe('knife')
    const knife = settingsOf({ ...stored.settings })
    expect(knife.buildStyle).toBe('knife')
    expect(knife).not.toHaveProperty('strategy')
    expect(settingsOf({ ...stored.settings, strategy: 'manhattan' }).buildStyle).toBe('manhattan')
    expect(settingsOf({ ...stored.settings, strategy: 'knife-cuts' }).buildStyle).toBe('knife')
  })

  it('keeps a build style as stored', () => {
    expect(settingsOf({ buildStyle: 'manhattan' }).buildStyle).toBe('manhattan')
  })

  it("drops the removed optimizer's settings", () => {
    expect(stored.settings).toMatchObject({ clearance: 3, maxLead: 10 })
    expect(settingsOf({ buildStyle: 'manhattan', placement: 'schematic', clearance: 3, maxLead: 10 })).toEqual({
      snap: 0.5,
      isolation: 0.4,
      buildStyle: 'manhattan',
    })
  })

  it('refuses an unknown build style', () => {
    expect(() => settingsOf({ strategy: 'teleport' })).toThrow('Unknown build style "teleport"')
    expect(() => settingsOf({ buildStyle: 'glue' })).toThrow('Unknown build style "glue"')
  })

  it('writes only the snap, isolation and build style', () => {
    const saved = JSON.parse(projectToFile(projectFromFile(example)))
    expect(saved.version).toBe(10)
    expect(Object.keys(saved.project.settings).sort()).toEqual(['buildStyle', 'isolation', 'snap'])
  })
})

describe('checkedProject footprint choices', () => {
  const stored = JSON.parse(example).project
  const choicesIn = (project: Project) =>
    Object.fromEntries(project.netlist.components.flatMap((c) => (c.chosenFootprint ? [[c.ref, c.chosenFootprint]] : [])))

  it('moves the footprint a placement held before v9 onto its part', () => {
    const placed = Object.fromEntries(stored.layout.placements.flatMap((p: { ref: string; footprint?: string }) => (p.footprint ? [[p.ref, p.footprint]] : [])))
    const throughHole = 'RES-TH_BD1.8-L3.3-P7.62-D0.45'
    expect(placed).toEqual({ R1: throughHole, R2: throughHole, R3: throughHole, R4: throughHole })
    const project = checkedProject(stored)
    expect(choicesIn(project)).toEqual(placed)
    expect(project.layout.placements.some((p) => 'footprint' in p)).toBe(false)
    const netlistFootprints = new Map(stored.netlist.components.map((c: { ref: string; footprint: string }) => [c.ref, c.footprint]))
    expect(project.netlist.components.every((c) => c.footprint === netlistFootprints.get(c.ref))).toBe(true)
  })

  it('keeps the parts\' choices through a save', () => {
    const saved = JSON.parse(projectToFile(projectFromFile(example))).project
    expect(saved.layout.placements.some((p: object) => 'footprint' in p)).toBe(false)
    expect(choicesIn(checkedProject(saved))).toEqual(choicesIn(checkedProject(stored)))
  })

  it('leaves a project without choices as it is', () => {
    const placements = stored.layout.placements.map(({ footprint: _footprint, ...p }: { footprint?: string }) => p)
    const project = checkedProject({ ...stored, layout: { ...stored.layout, placements } })
    expect(choicesIn(project)).toEqual({})
  })
})

describe('checkedProject schematic labels', () => {
  const stored = JSON.parse(example).project

  it('gives a stored label without a symbol the one its name suggests', () => {
    expect(stored.schematic.labels.every((l: object) => !('symbol' in l))).toBe(true)
    const symbols = Object.fromEntries(checkedProject(stored).schematic.labels.map((l) => [l.name, l.symbol]))
    expect(symbols).toMatchObject({ VCC: 'power', GND: 'ground', B1: 'net', LED1_A: 'net' })
  })

  it('keeps a stored symbol, also when the name suggests another', () => {
    const labels = [{ x: 0, y: 0, name: 'GND', symbol: 'terminal' }]
    const checked = checkedProject({ ...stored, schematic: { ...stored.schematic, labels } })
    expect(checked.schematic.labels.map((l) => l.symbol)).toEqual(['terminal'])
  })
})

describe('checkedProject schematic', () => {
  const stored = JSON.parse(example).project
  const refs = stored.netlist.components.map((c: { ref: string }) => c.ref)
  /** Pins whose connections in the schematic differ from the PCB's. */
  const pinsOffPcb = (project: Project) => pinsWithOtherNet(project.netlist, projectSchematicNets(project).netlist)
  /** One label per pin that is on a net, as the netlist has them. */
  const connectedPins = stored.netlist.components.flatMap((c: { pins: { net: string }[] }) => c.pins.filter((p) => p.net))

  it('keeps stored placements, wires and labels', () => {
    const checked = checkedProject(stored)
    expect(checked.schematic.placements.map((p) => p.ref)).toEqual(refs)
    expect(checked.schematic.placements).toEqual(expect.arrayContaining(stored.schematic.placements))
    expect(checked.schematic.wires).toEqual(stored.schematic.wires)
    expect(checked.schematic.labels.map(({ x, y, name }) => ({ x, y, name }))).toEqual(stored.schematic.labels)
  })

  it('places every part and labels every pin with its net in files from before the schematic', () => {
    const { schematic: _, ...withoutSchematic } = stored
    const checked = checkedProject(withoutSchematic)
    expect(checked.schematic.placements.map((p) => p.ref)).toEqual(refs)
    expect(checked.schematic.wires).toEqual([])
    expect(checked.schematic.labels).toHaveLength(connectedPins.length)
    expect(pinsOffPcb(checked)).toEqual([])
  })

  it('labels every pin with its net in files whose schematic was never edited, keeping the parts that were moved', () => {
    const moved = { ref: 'R1', x: 254, y: 254, rotation: 90 }
    const checked = checkedProject({ ...stored, schematic: { placements: [moved] } })
    expect(checked.schematic.placements.map((p) => p.ref)).toEqual(refs)
    expect(checked.schematic.placements.find((p) => p.ref === 'R1')).toEqual(moved)
    expect(checked.schematic.wires).toEqual([])
    expect(checked.schematic.labels).toHaveLength(connectedPins.length)
    expect(pinsOffPcb(checked)).toEqual([])
  })

  it('drops the placement of a part that is no longer in the netlist', () => {
    const gone = { ref: 'X9', x: 0, y: 0, rotation: 0 }
    const checked = checkedProject({ ...stored, schematic: { ...stored.schematic, placements: [...stored.schematic.placements, gone] } })
    expect(checked.schematic.placements.map((p) => p.ref)).toEqual(refs)
  })
})

describe('readSavedProject', () => {
  it('gives a project as this version writes it, and keeps text that is no project as it is', () => {
    expect(readSavedProject(example).content).toBe(projectToFile(projectFromFile(example)))
    expect(readSavedProject('hello')).toEqual({ project: null, content: 'hello' })
  })
})

describe('project file names', () => {
  it('turn a name into a file name and back', () => {
    expect(projectFileName('amp')).toBe('amp.json')
    expect(projectNameOf(projectFileName('amp'))).toBe('amp')
    expect(projectNameOf('amp.manhattan.json')).toBe('amp')
  })
})
