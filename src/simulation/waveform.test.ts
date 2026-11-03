import { describe, expect, it } from 'vitest'
import { measure } from './waveform'

describe('measure', () => {
  it('weighs each value by the time it lasts, as ngspice steps unevenly', () => {
    // 1 V for 3 s, then a quick step to 3 V held for 1 s.
    const result = measure([0, 3, 3, 4], [1, 1, 3, 3])
    expect(result).toEqual({ max: 3, min: 1, peakToPeak: 2, average: 1.5 })
  })

  it('takes a single sample as its own average', () => {
    expect(measure([0], [2]).average).toBe(2)
  })
})
