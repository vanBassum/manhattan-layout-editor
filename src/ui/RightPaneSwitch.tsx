import { Icon } from './icons'

/** What the right-hand pane shows: the board, or the simulation of the schematic. */
export type RightPane = 'pcb' | 'simulation'

export function RightPaneSwitch({ pane, onChange }: { pane: RightPane; onChange: (pane: RightPane) => void }) {
  return (
    <div className="view-switch pane-switch" role="group" aria-label="Right pane">
      <button className={pane === 'pcb' ? 'active' : ''} aria-pressed={pane === 'pcb'} onClick={() => onChange('pcb')}>
        <Icon name="grid" />PCB layout
      </button>
      <button className={pane === 'simulation' ? 'active' : ''} aria-pressed={pane === 'simulation'} onClick={() => onChange('simulation')}>
        <Icon name="wave" />Simulation
      </button>
    </div>
  )
}
