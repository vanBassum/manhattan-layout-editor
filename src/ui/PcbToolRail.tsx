import type { Layers, MoveMode, Tool } from '../Canvas'
import { GridSettings, Icon, LayerToggles, PCB_LAYERS, RailMenu } from '../panels'

interface PcbToolRailProps {
  tool: Tool
  onToolChange: (tool: Tool) => void
  onFit: () => void
  moveMode: MoveMode
  onMoveModeChange: (mode: MoveMode) => void
  /** Parts are selected for the part buttons to act on. */
  partsSelected: boolean
  onRotate: () => void
  onResetLeads: () => void
  onChangeFootprint: () => void
  gridLinesPerMajor: number
  onGridChange: (linesPerMajor: number) => void
  layers: Layers
  onLayersChange: (layers: Layers) => void
}

export function PcbToolRail(props: PcbToolRailProps) {
  const { tool, moveMode, partsSelected } = props
  return (
    <nav className="tool-rail" aria-label="Tools">
      <div className="rail-group" role="group" aria-label="View">
        <button
          className={tool === 'select' ? 'rail-button active' : 'rail-button'}
          onClick={() => props.onToolChange('select')}
          aria-pressed={tool === 'select'}
          title="Select (V): drag empty space to select, Shift+drag adds"
        >
          <Icon name="select" />Select
        </button>
        <button
          className={tool === 'pan' ? 'rail-button active' : 'rail-button'}
          onClick={() => props.onToolChange('pan')}
          aria-pressed={tool === 'pan'}
          title="Pan (H): drag empty space to move the view; middle mouse always pans"
        >
          <Icon name="pan" />Pan
        </button>
        <button className="rail-button" onClick={props.onFit} title="Fit the board in view (F)">
          <Icon name="fit" />Fit
        </button>
      </div>
      <div className="rail-group" role="group" aria-label="Component">
        <button
          className={moveMode === 'body' ? 'rail-button active' : 'rail-button'}
          onClick={() => props.onMoveModeChange(moveMode === 'body' ? 'part' : 'body')}
          aria-pressed={moveMode === 'body'}
          title={
            'Anchor leads (M). On: dragging a part moves only its body, lead ends stay where they are soldered. ' +
            'Off: the leads move along. Shift+drag always takes the leads along.'
          }
        >
          <Icon name="moveBody" />Anchor
        </button>
        <button className="rail-button" onClick={props.onRotate} disabled={!partsSelected} title="Rotate: Space = 90°, Shift+Space = 15°">
          <Icon name="rotate" />Rotate
        </button>
        <button className="rail-button" onClick={props.onResetLeads} disabled={!partsSelected} title="Straighten the selected parts' leads">
          <Icon name="leads" />Leads
        </button>
        <button className="rail-button" onClick={props.onChangeFootprint} disabled={!partsSelected} title="Choose another footprint for the selected parts">
          <Icon name="convert" />Footprint
        </button>
      </div>
      <div className="rail-group view">
        <RailMenu icon="grid" label="Grid" title="Grid settings">
          <GridSettings linesPerMajor={props.gridLinesPerMajor} onChange={props.onGridChange} />
        </RailMenu>
        <RailMenu icon="eye" label="View" title="Choose what is drawn">
          <LayerToggles info={PCB_LAYERS} layers={props.layers} onChange={props.onLayersChange} opacityNote=" (below 50% the layer ignores clicks)" />
        </RailMenu>
      </div>
    </nav>
  )
}
