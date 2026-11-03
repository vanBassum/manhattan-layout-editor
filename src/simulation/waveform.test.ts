import { describe, expect, it } from 'vitest'
import { measure, resample } from './waveform'

describe('resample', () => {
  it('reads an unevenly stepped waveform at even times, between its steps', () => {
    expect(resample([0, 1, 4], [0, 2, 8], 5)).toEqual({ time: [0, 1, 2, 3, 4], values: [0, 2, 4, 6, 8] })
  })
})

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
