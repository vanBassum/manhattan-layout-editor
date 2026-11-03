import { describe, expect, it } from 'vitest'
import { parseNetlist } from './netlist'
import type { Netlist } from './types'

/** What every fixture below describes: R1 from VCC to OUT, C1 from OUT to GND. */
const EXPECTED: Netlist = {
  components: [
    { ref: 'C1', value: '100n', footprint: 'C0805', pins: [{ number: '1', net: 'OUT' }, { number: '2', net: 'GND' }] },
    { ref: 'R1', value: '10k', footprint: 'R_AXIAL-0.4', pins: [{ number: '1', net: 'VCC' }, { number: '2', net: 'OUT' }] },
  ],
  nets: ['GND', 'OUT', 'VCC'],
}

describe('parseNetlist', () => {
  it('reads EasyEDA JSON, with pins given as a net name or as an object', () => {
    const text = JSON.stringify({
      gge2: { props: { designator: 'R1', Value: '10k', Footprint: 'R_AXIAL-0.4' }, pins: { '2': 'OUT', '1': 'VCC' } },
      gge1: { props: { Designator: 'C1', value: '100n', package: 'C0805' }, pins: { '1': { net: 'OUT' }, '2': { netName: 'GND' } } },
    })

    expect(parseNetlist(text)).toEqual(EXPECTED)
  })

  it('reads EasyEDA Pro JSON, which wraps the parts in "components"', () => {
    const text = JSON.stringify({
      components: {
        a: { props: { designator: 'R1', value: '10k', footprint: 'R_AXIAL-0.4' }, pins: { '1': 'VCC', '2': 'OUT' } },
        b: { props: { designator: 'C1', value: '100n', footprint: 'C0805' }, pins: { '1': 'OUT', '2': 'GND' } },
      },
    })

    expect(parseNetlist(text)).toEqual(EXPECTED)
  })

  it('reads a Telesis netlist, with continued lines and "{Value}" for no value', () => {
    const text = [
      '$PACKAGES',
      "'R_AXIAL-0.4' ! 'R_AXIAL-0.4' ! '10k' ; R1",
      "'C0805' ! 'C0805' ! '{Value}' ; C1",
      '$NETS',
      "'VCC' ; R1.1",
      "'OUT' ; R1.2,",
      'C1.1',
      "'GND' ; C1.2",
      '$END',
    ].join('\r\n')
    const withoutC1Value = { ...EXPECTED, components: [{ ...EXPECTED.components[0], value: '' }, EXPECTED.components[1]] }

    expect(parseNetlist(text)).toEqual(withoutC1Value)
  })

  it('reads a KiCad netlist and leaves out the nets of unconnected pins', () => {
    const text = `(export (version "E")
  (components
    (comp (ref "R1") (value "10k") (footprint "R_AXIAL-0.4"))
    (comp (ref "C1") (value "100n") (footprint "C0805"))
    (comp (ref "J1") (value "Conn") (footprint "Pin")))
  (nets
    (net (code "1") (name "VCC") (node (ref "R1") (pin "1")))
    (net (code "2") (name "OUT") (node (ref "R1") (pin "2")) (node (ref "C1") (pin "1")))
    (net (code "3") (name "GND") (node (ref "C1") (pin "2")))
    (net (code "4") (name "unconnected-(J1-Pad1)") (node (ref "J1") (pin "1")))))`
    const j1 = { ref: 'J1', value: 'Conn', footprint: 'Pin', pins: [{ number: '1', net: 'unconnected-(J1-Pad1)' }] }

    expect(parseNetlist(text)).toEqual({ ...EXPECTED, components: [...EXPECTED.components.slice(0, 1), j1, EXPECTED.components[1]] })
  })

  it('reads a Protel netlist', () => {
    const text = ['[', 'R1', 'R_AXIAL-0.4', '10k', ']', '[', 'C1', 'C0805', '100n', ']']
      .concat(['(', 'VCC', 'R1-1', ')', '(', 'OUT', 'R1-2', 'C1-1', ')', '(', 'GND', 'C1-2', ')'])
      .join('\n')

    expect(parseNetlist(text)).toEqual(EXPECTED)
  })

  it('refuses text in no known format, and a netlist without parts', () => {
    expect(() => parseNetlist('hello')).toThrow('Unrecognized netlist format')
    expect(() => parseNetlist('{}')).toThrow('Netlist contains no components.')
  })
})
