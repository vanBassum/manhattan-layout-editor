import { describe, expect, it } from 'vitest'
import { nearestIndex, niceTicks, panned, visibleSlice, zoomed } from './axis'

const full = { min: 0, max: 10 }

describe('niceTicks', () => {
  it('steps by 1, 2 or 5 times a power of ten, without float noise', () => {
    expect(niceTicks({ min: 0, max: 5 }, 5)).toEqual({ ticks: [0, 1, 2, 3, 4, 5], step: 1 })
    expect(niceTicks({ min: 0.1, max: 0.7 }, 3).ticks).toEqual([0.2, 0.4, 0.6])
    expect(niceTicks({ min: -0.6, max: 6.1 }, 8).step).toBe(1)
  })
})

describe('nearestIndex', () => {
  it('finds the closest value on either side', () => {
    expect(nearestIndex([0, 1, 4, 10], 2.4)).toBe(1)
    expect(nearestIndex([0, 1, 4, 10], 2.6)).toBe(2)
    expect(nearestIndex([0, 1, 4, 10], 99)).toBe(3)
  })
})

describe('zoomed', () => {
  it('keeps the anchor where it is on screen', () => {
    expect(zoomed(full, full, 0.5, 2)).toEqual({ min: 1, max: 6 })
  })

  it('never shows more than the data', () => {
    expect(zoomed({ min: 4, max: 6 }, full, 100, 5)).toEqual(full)
  })

  it('moves a window that would stick out back inside', () => {
    expect(zoomed({ min: 0, max: 2 }, full, 2, 1.5)).toEqual({ min: 0, max: 4 })
  })

  it('stops at a ten-thousandth of the data', () => {
    const window = zoomed({ min: 5, max: 5.002 }, full, 0.01, 5)
    expect(window.max - window.min).toBeCloseTo(1e-3, 12)
  })
})

describe('panned', () => {
  it('shifts the window and stops at the ends', () => {
    expect(panned({ min: 2, max: 4 }, full, 1)).toEqual({ min: 3, max: 5 })
    expect(panned({ min: 2, max: 4 }, full, -5)).toEqual({ min: 0, max: 2 })
  })
})

describe('visibleSlice', () => {
  it('takes the values in the window plus one either side', () => {
    expect(visibleSlice([0, 1, 2, 3, 4, 5, 6], { min: 2, max: 4 })).toEqual({ start: 1, end: 6 })
    expect(visibleSlice([0, 1, 2], full)).toEqual({ start: 0, end: 3 })
  })
})
