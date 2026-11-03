import { refPrefix } from '../model/footprintTemplates'
import type { NetComponent } from '../model/types'
import { partValue, type OperatingPoint } from './spiceNetlist'

/** One reading of a probed part, e.g. Ic = -0.0604 A. */
export interface ProbeRow {
  name: string
  value: number
  unit: string
}

/**
 * What the operating point says about `component`: a transistor's Vce, Vbe, Ic, Ib and the power it
 * dissipates; for a two-pin part the voltage across it (pin 1 against pin 2), and for a resistor
 * also its current and power. Undefined for a part the operating point says nothing about.
 */
export function probePart(component: NetComponent, point: OperatingPoint): ProbeRow[] | undefined {
  const transistor = point.transistors.find((t) => t.ref === component.ref)
  if (transistor) {
    const { vce, vbe, ic, ib } = transistor
    return [
      { name: 'Vce', value: vce, unit: 'V' },
      { name: 'Vbe', value: vbe, unit: 'V' },
      { name: 'Ic', value: ic, unit: 'A' },
      { name: 'Ib', value: ib, unit: 'A' },
      // Collector and base currents both flow through the transistor towards the emitter.
      { name: 'P', value: vce * ic + vbe * ib, unit: 'W' },
    ]
  }
  if (component.pins.length !== 2) return undefined
  const [a, b] = component.pins.map((p) => point.volts.get(p.net))
  if (a === undefined || b === undefined) return undefined
  const across: ProbeRow = { name: 'V', value: a - b, unit: 'V' }
  const ohms = refPrefix(component.ref).startsWith('R') ? partValue(component.value) : undefined
  if (ohms === undefined || ohms === 0) return [across]
  const amps = (a - b) / ohms
  return [across, { name: 'I', value: amps, unit: 'A' }, { name: 'P', value: (a - b) * amps, unit: 'W' }]
}
