import type { FullSchematic } from '../model/schematic'
import type { BuiltNetlist, Layout, Settings, StrategyId } from '../model/types'

/**
 * A layout strategy builds a complete, editable layout from the netlist. It only decides geometry:
 * islands are still one per net and parts still connect to the nets the netlist says. The
 * schematic only tells where the user drew each part; its nets are not the PCB's until "Update PCB".
 */
export interface Strategy {
  id: StrategyId
  label: string
  description: string
  /** Whether a clicked rectangle of an island gets resize handles, or the island is only edited by its outline. */
  rectHandles: boolean
  run: (netlist: BuiltNetlist, settings: Settings, schematic: FullSchematic) => Layout
}
