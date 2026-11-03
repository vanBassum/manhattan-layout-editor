import { Icon } from './icons'
import type { RightPane } from './preferences'

/** Picks what the pane beside the schematic shows. */
export function RightPaneSwitch({ pane, onChange }: { pane: RightPane; onChange: (pane: RightPane) => void }) {
  return (
    <div className="view-switch" role="group" aria-label="Right pane">
      <button className={pane === 'pcb' ? 'active' : ''} aria-pressed={pane === 'pcb'} onClick={() => onChange('pcb')}>
        <Icon name="grid" />PCB layout
      </button>
      <button className={pane === 'simulation' ? 'active' : ''} aria-pressed={pane === 'simulation'} onClick={() => onChange('simulation')}>
        <Icon name="wave" />Simulation
      </button>
    </div>
  )
}
