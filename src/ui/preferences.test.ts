import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_LAYERS, parseGridLinesPerMajor, parseLayerView, parseLayerViews, parseTheme, parseView } from './preferences'

afterEach(() => vi.unstubAllGlobals())

describe('parseLayerView', () => {
  it('reads the current form, keeping the opacity between 0 and 1', () => {
    expect(parseLayerView({ visible: false, opacity: 0.4 })).toEqual({ visible: false, opacity: 0.4 })
    expect(parseLayerView({ visible: true, opacity: 3 })).toEqual({ visible: true, opacity: 1 })
    expect(parseLayerView({ opacity: -1 })).toEqual({ visible: true, opacity: 0 })
    expect(parseLayerView({ visible: true })).toEqual({ visible: true, opacity: 1 })
  })

  it('reads the older true/false form', () => {
    expect(parseLayerView(true)).toEqual({ visible: true, opacity: 1 })
    expect(parseLayerView(false)).toEqual({ visible: false, opacity: 1 })
  })

  it("reads the older 'on'/'faded'/'off' form", () => {
    expect(parseLayerView('on')).toEqual({ visible: true, opacity: 1 })
    expect(parseLayerView('faded')).toEqual({ visible: true, opacity: 0.15 })
    expect(parseLayerView('off')).toEqual({ visible: false, opacity: 1 })
  })
})

describe('parseLayerViews', () => {
  it('takes the stored layers and the defaults for the rest', () => {
    const layers = parseLayerViews(JSON.stringify({ islands: 'off', leads: { visible: true, opacity: 0.5 }, unknown: false }), ALL_LAYERS)

    expect(layers).toEqual({ ...ALL_LAYERS, islands: { visible: false, opacity: 1 }, leads: { visible: true, opacity: 0.5 } })
  })

  it('gives the defaults when nothing or no JSON is stored', () => {
    expect(parseLayerViews(null, ALL_LAYERS)).toBe(ALL_LAYERS)
    expect(parseLayerViews('{not json', ALL_LAYERS)).toBe(ALL_LAYERS)
  })
})

describe('parseGridLinesPerMajor', () => {
  it('takes a stored option and falls back for anything else', () => {
    expect(parseGridLinesPerMajor('8', 5)).toBe(8)
    expect(parseGridLinesPerMajor('7', 5)).toBe(5)
    expect(parseGridLinesPerMajor(null, 5)).toBe(5)
  })
})

describe('parseView', () => {
  it('takes a stored view and shows both views otherwise', () => {
    expect(parseView('layout')).toBe('layout')
    expect(parseView('pcb')).toBe('split')
    expect(parseView(null)).toBe('split')
  })
})

describe('parseTheme', () => {
  it("takes a stored theme and follows the system's otherwise", () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })

    expect(parseTheme('light')).toBe('light')
    expect(parseTheme(null)).toBe('dark')
    expect(parseTheme('blue')).toBe('dark')
  })
})
