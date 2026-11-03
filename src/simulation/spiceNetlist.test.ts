import { describe, expect, it } from 'vitest'
import sziklai from '../examples/Sziklai emittor follower.json?raw'
import { projectFromFile } from '../documents/projectFormat'
import type { Netlist, Simulation, Source } from '../model/types'
import { runInEngine } from './spiceEngine'
import { operatingPointNetlist, partValue, readOperatingPoint, readTransient, spiceCircuit, transientNetlist } from './spiceNetlist'

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
const fiveVolts: Simulation = { sources: [{ net: 'VCC', shape: 'dc', volts: 5 }], models: {} }

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
    expect(() => spiceCircuit(netlist, undefined, { sources: [], models: {} })).toThrow(
      'R1: cannot read "ten" as a value\nQ1: no SPICE model for "BC547"\nAdd a source: nothing powers the circuit',
    )
  })

  it('refuses a model that defines another name', () => {
    const netlist: Netlist = {
      components: [{ ref: 'D1', value: '1N4148', footprint: '', pins: [{ number: '1', net: 'A' }, { number: '2', net: 'GND' }] }],
      nets: ['A', 'GND'],
    }
    const simulation = { sources: [{ net: 'A', shape: 'dc' as const, volts: 1 }], models: { '1N4148': '.model D1N4148 D(IS=2.5n)' } }
    expect(() => spiceCircuit(netlist, undefined, simulation)).toThrow('D1: the model for "1N4148" does not start with ".model 1N4148"')
  })

  it('gives a net whose name ngspice would change a node of its own', () => {
    const netlist: Netlist = {
      components: [{ ref: 'R1', value: '1k', footprint: '', pins: [{ number: '1', net: 'Net-(R1-Pad1)' }, { number: '2', net: 'GND' }] }],
      nets: ['GND', 'Net-(R1-Pad1)'],
    }
    const circuit = spiceCircuit(netlist, undefined, { sources: [{ net: 'Net-(R1-Pad1)', shape: 'dc', volts: 1 }], models: {} })
    expect(circuit.nodes.get('Net-(R1-Pad1)')).toBe('n1')
  })
})

describe('operating point in ngspice', () => {
  it('solves a divider', async () => {
    const circuit = spiceCircuit(divider, undefined, fiveVolts)
    const point = readOperatingPoint(circuit, (await runInEngine(operatingPointNetlist(circuit))).vectors)
    expect(point.volts.get('MID')).toBeCloseTo(3.75, 6)
    expect(point.volts.get('GND')).toBe(0)
    expect(point.dcSources).toEqual([{ net: 'VCC', volts: 5, amps: expect.closeTo(1.25e-3, 9) }])
  })

  it('biases the Sziklai example with both transistors on', async () => {
    const project = projectFromFile(sziklai)
    const circuit = spiceCircuit(project.netlist, project.definitions, project.simulation!)
    const point = readOperatingPoint(circuit, (await runInEngine(operatingPointNetlist(circuit))).vectors)
    expect(point.volts.get('VOUT')).toBeGreaterThan(4)
    expect(point.volts.get('VOUT')).toBeLessThan(7)
    const q2 = point.transistors.find((t) => t.ref === 'Q2')!
    expect(q2.vbe).toBeGreaterThan(0.5)
    expect(q2.ic).toBeGreaterThan(0)
    // The PNP's currents come out of its collector and base.
    expect(point.transistors.find((t) => t.ref === 'Q1')!.ic).toBeLessThan(0)
  })

  it('reports what ngspice could not parse', async () => {
    await expect(runInEngine('* bad\nV1 a 0 DC 5\nQ1 a a 0 NOPE\n.op\n.end')).rejects.toThrow(/can't find model 'nope'/)
  })
})

describe('wave sources', () => {
  const sziklaiWith = (wave: Source) => {
    const project = projectFromFile(sziklai)
    return spiceCircuit(project.netlist, project.definitions, { ...project.simulation!, sources: [{ net: 'VCC', shape: 'dc', volts: 12 }, wave] })
  }

  it('holds its net at 0 V for the operating point, so an input behind a capacitor no longer floats', async () => {
    const circuit = sziklaiWith({ net: 'VIN', shape: 'square', volts: 0.5, hertz: 1e6 })
    const run = await runInEngine(operatingPointNetlist(circuit))
    expect(readOperatingPoint(circuit, run.vectors).volts.get('VIN')).toBeCloseTo(0, 9)
    expect(run.warnings).toEqual([])
  })

  it('refuses a net another source already drives', () => {
    expect(() => sziklaiWith({ net: 'VCC', shape: 'sine', volts: 1, hertz: 1e3 })).toThrow('Source on VCC: another source already drives that net')
  })

  it('shows a square wave through the follower for five periods', async () => {
    const circuit = sziklaiWith({ net: 'VIN', shape: 'square', volts: 0.5, hertz: 1e6 })
    const trace = readTransient(circuit, (await runInEngine(transientNetlist(circuit))).vectors)
    expect(trace.time.at(-1)).toBeCloseTo(5e-6, 12)
    const at = (net: string, seconds: number) => trace.volts.get(net)![trace.time.findIndex((t) => t >= seconds)]
    // Late in the first high half the edge has settled: the output follows the input with a gain near 1.
    expect(at('VIN', 0.4e-6)).toBeCloseTo(0.5, 6)
    expect(at('VOUT', 0.4e-6) - at('VOUT', 0)).toBeCloseTo(0.5, 1)
    expect(at('VIN', 0.9e-6)).toBeCloseTo(-0.5, 6)
  })
})
