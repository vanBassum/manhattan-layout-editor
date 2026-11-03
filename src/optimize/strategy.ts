import type { BuiltNetlist, Layout, Settings } from '../types'

/**
 * A layout strategy builds a complete, editable layout from the netlist. It only decides geometry:
 * islands are still one per net and parts still connect to the nets the netlist says.
 */
export interface Strategy {
  id: string
  label: string
  description: string
  run: (netlist: BuiltNetlist, settings: Settings) => Layout
}
