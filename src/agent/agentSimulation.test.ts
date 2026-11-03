import { describe, expect, it } from 'vitest'
import sziklai from '../examples/Sziklai emittor follower.json?raw'
import { projectFromFile } from '../documents/projectFormat'
import { changedSimulation, describeSimulation } from './agentSimulation'

const project = projectFromFile(sziklai)

describe('set_simulation', () => {
  it('merges models by value and removes one given null, keeping the sources', () => {
    const changed = changedSimulation(project, { models: { BC546: null, BC547: '.model BC547 NPN(BF=300)' } })
    expect(Object.keys(changed.models).sort()).toEqual(['BC547', 'BD140'])
    expect(changed.sources).toEqual(project.simulation!.sources)
  })

  it('refuses a source it cannot simulate', () => {
    expect(() => changedSimulation(project, { sources: [{ net: 'VIN', shape: 'square', volts: 1, hertz: 1000 }] })).toThrow(/"sources" must be/)
  })
})

describe('get_simulation', () => {
  it('says which models the schematic needs and why it cannot run without them', () => {
    const withoutBc546 = { ...project, simulation: changedSimulation(project, { models: { BC546: null } }) }
    const described = describeSimulation(withoutBc546)
    expect(described.needs.models).toEqual([
      { value: 'BD140', refs: ['Q1'], present: true },
      { value: 'BC546', refs: ['Q2'], present: false },
    ])
    expect(described.problems).toEqual(['Q2: no SPICE model for "BC546"'])
  })
})
