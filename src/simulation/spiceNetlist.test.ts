import { describe, expect, it } from 'vitest'
import sziklai from '../examples/Sziklai emittor follower.json?raw'
import { projectFromFile } from '../documents/projectFormat'
import type { Netlist, Simulation } from '../model/types'
import { runSpice } from './ngspice'
import { operatingPointNetlist, partValue, readOperatingPoint, spiceCircuit } from './spiceNetlist'

describe('partValue', () => {
  it.each([
    ['12k', 12e3],
    ['4k7', 4.7e3],
    ['2.2uF', 2.2e-6],
    ['220uF', 220e-6],
    ['100n', 100e-9],
    ['80Ω', 80],
    ['2R2', 2.2],
    ['1M', 1e6],
    ['10m', 10e-3],
    ['47 pF', 47e-12],
  ])('reads %s', (text, expected) => {
    expect(partValue(text)).toBeCloseTo(expected, 15)
  })

  it.each(['', 'BD140', '1.5k7', '4 7', '10 kΩ x'])('refuses %j', (text) => {
    expect(partValue(text)).toBeUndefined()
  })
})

const divider: Netlist = {
  components: [
    { ref: 'R1', value: '1k', footprint: '', pins: [{ number: '1', net: 'VCC' }, { number: '2', net: 'MID' }] },
    { ref: 'R2', value: '3k', footprint: '', pins: [{ number: '1', net: 'MID' }, { number: '2', net: 'GND' }] },
  ],
  nets: ['GND', 'MID', 'VCC'],
}
const fiveVolts: Simulation = { supplies: [{ net: 'VCC', volts: 5 }], models: {} }

describe('spiceCircuit', () => {
  it('writes parts with ground as node 0 and values as plain numbers', () => {
    const circuit = spiceCircuit(divider, undefined, fiveVolts)
    expect(circuit.lines).toEqual(['* Manhattan schematic', 'R1 vcc mid 1000', 'R2 mid 0 3000', 'V_vcc vcc 0 DC 5'])
  })

  it('lists every problem at once', () => {
    const netlist: Netlist = {
      components: [
        { ref: 'R1', value: 'ten', footprint: '', pins: [{ number: '1', net: 'A' }, { number: '2', net: 'GND' }] },
        { ref: 'Q1', value: 'BC547', footprint: 'TO-92', pins: [{ number: '1', net: 'A' }, { number: '2', net: 'B' }, { number: '3', net: 'GND' }] },
      ],
      nets: ['A', 'B', 'GND'],
    }
    expect(() => spiceCircuit(netlist, undefined, { supplies: [], models: {} })).toThrow(
      'R1: cannot read "ten" as a value\nQ1: no SPICE model for "BC547"\nAdd a supply: nothing powers the circuit',
    )
  })

  it('refuses a model that defines another name', () => {
    const netlist: Netlist = {
      components: [{ ref: 'D1', value: '1N4148', footprint: '', pins: [{ number: '1', net: 'A' }, { number: '2', net: 'GND' }] }],
      nets: ['A', 'GND'],
    }
    const simulation = { supplies: [{ net: 'A', volts: 1 }], models: { '1N4148': '.model D1N4148 D(IS=2.5n)' } }
    expect(() => spiceCircuit(netlist, undefined, simulation)).toThrow('D1: the model for "1N4148" does not start with ".model 1N4148"')
  })

  it('gives a net whose name ngspice would change a node of its own', () => {
    const netlist: Netlist = {
      components: [{ ref: 'R1', value: '1k', footprint: '', pins: [{ number: '1', net: 'Net-(R1-Pad1)' }, { number: '2', net: 'GND' }] }],
      nets: ['GND', 'Net-(R1-Pad1)'],
    }
    const circuit = spiceCircuit(netlist, undefined, { supplies: [{ net: 'Net-(R1-Pad1)', volts: 1 }], models: {} })
    expect(circuit.nodes.get('Net-(R1-Pad1)')).toBe('n1')
  })
})

describe('operating point in ngspice', () => {
  it('solves a divider', async () => {
    const circuit = spiceCircuit(divider, undefined, fiveVolts)
    const point = readOperatingPoint(circuit, (await runSpice(operatingPointNetlist(circuit))).vectors)
    expect(point.volts.get('MID')).toBeCloseTo(3.75, 6)
    expect(point.volts.get('GND')).toBe(0)
    expect(point.supplies).toEqual([{ net: 'VCC', volts: 5, amps: expect.closeTo(1.25e-3, 9) }])
  })

  it('biases the Sziklai example with both transistors on', async () => {
    const project = projectFromFile(sziklai)
    const circuit = spiceCircuit(project.netlist, project.definitions, project.simulation!)
    const point = readOperatingPoint(circuit, (await runSpice(operatingPointNetlist(circuit))).vectors)
    expect(point.volts.get('VOUT')).toBeGreaterThan(4)
    expect(point.volts.get('VOUT')).toBeLessThan(7)
    const q2 = point.transistors.find((t) => t.ref === 'Q2')!
    expect(q2.vbe).toBeGreaterThan(0.5)
    expect(q2.ic).toBeGreaterThan(0)
    // The PNP's currents come out of its collector and base.
    expect(point.transistors.find((t) => t.ref === 'Q1')!.ic).toBeLessThan(0)
  })

  it('reports what ngspice could not parse', async () => {
    await expect(runSpice('* bad\nV1 a 0 DC 5\nQ1 a a 0 NOPE\n.op\n.end')).rejects.toThrow(/can't find model 'nope'/)
  })
})
