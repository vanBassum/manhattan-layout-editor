import { describe, expect, it } from 'vitest'
import { symbolTemplate } from './schematicSymbols'
import type { NetComponent } from './types'

const part = (ref: string, footprint: string, pinCount = 2, value = ''): NetComponent => ({
  ref,
  value,
  footprint,
  pins: Array.from({ length: pinCount }, (_, k) => ({ number: String(k + 1), net: '' })),
})

const kindOf = (component: NetComponent) => symbolTemplate(component).kind

describe('symbolTemplate', () => {
  it('tells electrolytic capacitors from others by their footprint name', () => {
    expect(kindOf(part('C1', 'CAP-TH_BD5.0-P2.00'))).toBe('electrolytic')
    expect(kindOf(part('C1', 'CP_Radial_D5.0mm_P2.00mm'))).toBe('electrolytic')
    expect(kindOf(part('C1', 'Capacitor_THT:CP_Radial_D5.0mm_P2.00mm'))).toBe('electrolytic')
    expect(kindOf(part('C1', 'CAP-TH_L5.5-W2.5-P5.00'))).toBe('capacitor')
  })

  it('takes a part for an LED by its footprint, reference or value', () => {
    expect(kindOf(part('D1', 'LED-TH_3mm'))).toBe('led')
    expect(kindOf(part('LED1', ''))).toBe('led')
    expect(kindOf(part('D1', '', 2, 'LED red'))).toBe('led')
    expect(kindOf(part('D1', 'DO-35_BD1.9-L3.8-P7.62'))).toBe('diode')
  })

  it('orders transistor pins by package', () => {
    expect(kindOf(part('Q1', 'TO-92-3_L4.9-W3.7-P2.54-L', 3, 'BC547'))).toBe('npn-cbe')
    expect(kindOf(part('Q1', 'TO-126-3_L7.6-W2.7-P2.30-L', 3, 'BD140'))).toBe('pnp-ecb')
    expect(kindOf(part('Q1', 'SOT-23-3_L2.9-W1.3', 3, '2N3904'))).toBe('npn-ebc')
  })

  it('takes a three-pin part for a trimmer by its footprint or reference', () => {
    expect(kindOf(part('R1', 'RES-ADJ-TH_3296W_L9.5-W4.8-P2.54', 3))).toBe('trimmer')
    expect(kindOf(part('RV1', '', 3))).toBe('trimmer')
  })
})
