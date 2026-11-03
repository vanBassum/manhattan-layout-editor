import { useState } from 'react'
import { SHOWN, type LayerView } from './layers'
import { GRID_LINES_PER_MAJOR_OPTIONS } from './panels'

/** Which views are shown: one of them, or both side by side. */
export type ViewMode = 'schematic' | 'split' | 'layout'
export type Theme = 'light' | 'dark'

// Layer visibility is a per-browser view preference, deliberately not part of the project.
export const LAYERS_KEY = 'manhattan-layout-editor/layers'
export const SCHEMATIC_LAYERS_KEY = 'manhattan-layout-editor/schematic-layers'
export const PCB_GRID_KEY = 'manhattan-layout-editor/pcb-grid-lines-per-major'
export const SCHEMATIC_GRID_KEY = 'manhattan-layout-editor/schematic-grid-lines-per-major'
export const THEME_KEY = 'manhattan-layout-editor/theme'
export const VIEW_KEY = 'manhattan-layout-editor/view'

export const DEFAULT_SCHEMATIC_GRID_LINES_PER_MAJOR = 6

// Storage can be disabled (private window, blocked site data); preferences then last one session.
function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {}
}

/**
 * State kept as a per-browser preference under `key`; `parse` turns the stored text (null when
 * there is none) into the value. Strings are stored as they are, anything else as JSON.
 */
export function usePreference<Value>(key: string, parse: (stored: string | null) => Value): [Value, (next: Value) => void] {
  const [value, setValue] = useState(() => parse(readPreference(key)))
  const change = (next: Value) => {
    setValue(next)
    writePreference(key, typeof next === 'string' ? next : JSON.stringify(next))
  }
  return [value, change]
}

export function parseGridLinesPerMajor(stored: string | null, fallback: number): number {
  const linesPerMajor = Number(stored)
  return GRID_LINES_PER_MAJOR_OPTIONS.includes(linesPerMajor) ? linesPerMajor : fallback
}

export function parseView(stored: string | null): ViewMode {
  if (stored === 'schematic' || stored === 'split' || stored === 'layout') return stored
  return 'split'
}

/** The stored theme, or the system's when none was picked. */
export function parseTheme(stored: string | null): Theme {
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Reads a stored layer setting, including the older true/false and 'on'/'faded'/'off' forms. */
export function parseLayerView(value: unknown): LayerView {
  if (value === false || value === 'off') return { visible: false, opacity: 1 }
  if (value === 'faded') return { visible: true, opacity: 0.15 }
  if (typeof value === 'object' && value !== null) {
    const { visible, opacity } = value as Partial<LayerView>
    return { visible: visible !== false, opacity: typeof opacity === 'number' ? Math.min(1, Math.max(0, opacity)) : 1 }
  }
  return SHOWN
}

/** The stored layer settings, with `defaults` for layers they do not mention. */
export function parseLayerViews<Name extends string>(stored: string | null, defaults: Record<Name, LayerView>): Record<Name, LayerView> {
  if (!stored) return defaults
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>
    const layers = { ...defaults }
    for (const layer of Object.keys(layers) as Name[]) {
      if (layer in parsed) layers[layer] = parseLayerView(parsed[layer])
    }
    return layers
  } catch {
    return defaults
  }
}
