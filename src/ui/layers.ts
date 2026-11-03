import type { CSSProperties } from 'react'

export interface LayerView {
  visible: boolean
  /** 0..1 */
  opacity: number
}

export type LayerName = 'islands' | 'parts' | 'references' | 'values' | 'netLabels' | 'leads' | 'grid'

/** View-only settings; hidden layers stay in the DOM so the agent screenshot can still show them. */
export type Layers = Record<LayerName, LayerView>

export type SchematicLayer = 'grid' | 'references' | 'values' | 'pinNumbers' | 'netNames'

/** View-only: which parts of the drawing are shown, and how strongly. A per-browser preference, not part of the project. */
export type SchematicLayers = Record<SchematicLayer, LayerView>

export type LayerInfo<Name extends string> = Record<Name, { label: string; swatch: string }>

export const PCB_LAYERS: LayerInfo<LayerName> = {
  islands: { label: 'Copper islands', swatch: '#d9904f' },
  parts: { label: 'Components', swatch: '#4a4a4a' },
  references: { label: 'References', swatch: '#333333' },
  values: { label: 'Values', swatch: '#777777' },
  netLabels: { label: 'Net labels', swatch: '#5a3b1c' },
  leads: { label: 'Leads / ratsnest', swatch: '#2f9e44' },
  grid: { label: 'Grid', swatch: '#c7cdd4' },
}

export const SCHEMATIC_LAYERS: LayerInfo<SchematicLayer> = {
  references: { label: 'References', swatch: '#333333' },
  values: { label: 'Values', swatch: '#777777' },
  pinNumbers: { label: 'Pin numbers', swatch: '#aaaaaa' },
  netNames: { label: 'Net names', swatch: '#2a7fff' },
  grid: { label: 'Grid', swatch: '#c7cdd4' },
}

export const SHOWN: LayerView = { visible: true, opacity: 1 }
export const ALL_LAYERS: Layers = { islands: SHOWN, parts: SHOWN, references: SHOWN, values: SHOWN, netLabels: SHOWN, leads: SHOWN, grid: SHOWN }

/** Net names are off until asked for: the wires already show what connects, the names only add clutter. */
export const DEFAULT_SCHEMATIC_LAYERS: SchematicLayers = {
  grid: SHOWN,
  references: SHOWN,
  values: SHOWN,
  pinNumbers: SHOWN,
  netNames: { visible: false, opacity: 1 },
}

/** Below this opacity a layer ignores clicks, so you can work on what lies underneath it. */
const CLICKABLE_OPACITY = 0.5

/**
 * Classes read by the stylesheet: hide-<layer> for each hidden layer, and with `dimFaint`
 * dim-<layer> for each layer too faint to click.
 */
export function layerClasses(layers: Record<string, LayerView>, { dimFaint }: { dimFaint: boolean }): string[] {
  return Object.entries(layers).flatMap(([layer, view]) => {
    if (!view.visible) return [`hide-${layer}`]
    return dimFaint && view.opacity < CLICKABLE_OPACITY ? [`dim-${layer}`] : []
  })
}

/** CSS variables --opacity-<layer>, read by the stylesheet. */
export function layerOpacities(layers: Record<string, LayerView>): CSSProperties {
  return Object.fromEntries(Object.entries(layers).map(([layer, view]) => [`--opacity-${layer}`, view.opacity]))
}
