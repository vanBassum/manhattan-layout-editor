import { describe, expect, it } from 'vitest'
import type { NetComponent } from '../model/types'
import { probePart } from './probe'
import type { OperatingPoint } from './spiceNetlist'

const point: OperatingPoint = {
  volts: new Map([
    ['VCC', 12],
    ['MID', 4],
    ['GND', 0],
  ]),
  dcSources: [],
  transistors: [{ ref: 'Q1', vbe: 0.7, vce: 5, ic: 0.01, ib: 0.0001 }],
}

const part = (ref: string, value: string, nets: string[]): NetComponent => ({
  ref,
  value,
  footprint: '',
  pins: nets.map((net, k) => ({ number: String(k + 1), net })),
})

describe('probePart', () => {
  it('gives a transistor its voltages, currents and dissipation', () => {
    expect(probePart(part('Q1', 'BC547', ['VCC', 'MID', 'GND']), point)).toEqual([
      { name: 'Vce', value: 5, unit: 'V' },
      { name: 'Vbe', value: 0.7, unit: 'V' },
      { name: 'Ic', value: 0.01, unit: 'A' },
      { name: 'Ib', value: 0.0001, unit: 'A' },
      { name: 'P', value: expect.closeTo(0.05007, 9), unit: 'W' },
    ])
  })

  it('gives a resistor the voltage across it, its current and power', () => {
    expect(probePart(part('R1', '4k', ['VCC', 'MID']), point)).toEqual([
      { name: 'V', value: 8, unit: 'V' },
      { name: 'I', value: 0.002, unit: 'A' },
      { name: 'P', value: 0.016, unit: 'W' },
    ])
  })

  it('gives another two-pin part only the voltage across it', () => {
    expect(probePart(part('C1', '100n', ['MID', 'GND']), point)).toEqual([{ name: 'V', value: 4, unit: 'V' }])
  })

  it('says nothing about a part on nets the run did not see', () => {
    expect(probePart(part('R9', '1k', ['ELSEWHERE', 'GND']), point)).toBeUndefined()
  })
})
