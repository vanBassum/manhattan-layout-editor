import { describe, expect, it } from 'vitest'
import example from './examples/multivibrator.manhattan.json?raw'
import { addComponent } from './agentCommands'
import { buildNetlist } from './definitions'
import { projectFromFile } from './projectStore'
import { completeSchematic, deriveNets, pinsWithOtherNet } from './schematic'
import type { Project } from './types'

const exampleProject = () => projectFromFile(example)

/** Pins whose net differs between the PCB and what the schematic draws. */
function pinsOutOfSync(project: Project): string[] {
  const built = buildNetlist(project.netlist, project.layout.placements, project.definitions)
  const nets = deriveNets(project.netlist, built, completeSchematic(built, project.schematic))
  return pinsWithOtherNet(project.netlist, nets.netlist)
}

describe('addComponent', () => {
  it('connects the new part in the PCB and the schematic alike', () => {
    const project = exampleProject()
    const before = pinsOutOfSync(project)
    const added = { ...project, ...addComponent(project, { ref: 'C9', pins: [{ number: '1', net: 'VCC' }, { number: '2', net: 'NEW' }], x: 50, y: 50 }) }
    expect(pinsOutOfSync(added)).toEqual(before)
    expect(added.netlist.nets).toContain('NEW')
    expect(added.layout.islands.some((i) => i.net === 'NEW')).toBe(true)
  })

  it('places a part that uses a definition with that definition on the PCB', () => {
    const project = exampleProject()
    const id = project.netlist.components.find((c) => c.ref === 'R1')!.definition!
    const definition = project.definitions![id]
    const footprint = Object.keys(definition.footprints)[0]
    const added = { ...project, ...addComponent(project, { ref: 'R9', definition: id }) }
    const part = buildNetlist(added.netlist, added.layout.placements, added.definitions).components.find((c) => c.ref === 'R9')!
    expect(part.footprint).toBe(footprint)
    expect(part.geometry.body).toEqual(definition.footprints[footprint].body)
  })

  it('refuses a reference that is taken', () => {
    expect(() => addComponent(exampleProject(), { ref: 'R1', pins: [{ number: '1' }] })).toThrow('already')
  })
})
