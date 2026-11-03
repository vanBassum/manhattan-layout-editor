import type { SchematicTool } from '../SchematicView'
import { Icon, type IconName } from './icons'
import { SCHEMATIC_LAYERS, type SchematicLayers } from './layers'
import { GridSettings, LayerToggles, RailMenu } from './panels'

const SCHEMATIC_TOOLS: { id: SchematicTool; icon: IconName; label: string; title: string }[] = [
  {
    id: 'select',
    icon: 'select',
    label: 'Select',
    title:
      'Select (V): click parts, wires, labels and wire corners; Shift+click adds. Drag empty space to the right to ' +
      'select what lies inside, to the left for what it touches. Dragging the selection keeps its connections; ' +
      'Shift+drag moves it alone. Drag from a pin end to draw a wire (Shift: from a wire end). Del removes wires and labels',
  },
  {
    id: 'wire',
    icon: 'wire',
    label: 'Wire',
    title:
      'Wire (W): drag for one wire, or click corner by corner and double-click or Esc to stop. Space flips the bend. ' +
      'Ending on a pin, a wire end or the middle of a wire connects; crossing wires do not',
  },
  { id: 'label', icon: 'label', label: 'Label', title: 'Label (L): click a point to name its net; labels with the same name are connected. Double-click a label to rename it' },
]

interface SchematicToolRailProps {
  tool: SchematicTool
  onToolChange: (tool: SchematicTool) => void
  onFit: () => void
  /** Something is selected that rotates and flips. */
  canTurn: boolean
  onRotate: () => void
  onFlip: (axis: 'horizontal' | 'vertical') => void
  gridLinesPerMajor: number
  onGridChange: (linesPerMajor: number) => void
  layers: SchematicLayers
  onLayersChange: (layers: SchematicLayers) => void
}

export function SchematicToolRail(props: SchematicToolRailProps) {
  const { tool, canTurn } = props
  return (
    <nav className="tool-rail" aria-label="Schematic tools">
      <div className="rail-group" role="group" aria-label="Tools">
        {SCHEMATIC_TOOLS.map(({ id, icon, label, title }) => (
          <button
            key={id}
            className={tool === id ? 'rail-button active' : 'rail-button'}
            onClick={() => props.onToolChange(id)}
            aria-pressed={tool === id}
            title={title}
          >
            <Icon name={icon} />{label}
          </button>
        ))}
        <button className="rail-button" onClick={props.onFit} title="Fit the schematic in view (F)">
          <Icon name="fit" />Fit
        </button>
      </div>
      <div className="rail-group" role="group" aria-label="Component">
        <button className="rail-button" onClick={props.onRotate} disabled={!canTurn} title="Rotate a quarter turn (Space)">
          <Icon name="rotate" />Rotate
        </button>
        <button className="rail-button" onClick={() => props.onFlip('horizontal')} disabled={!canTurn} title="Mirror left to right (X)">
          <Icon name="flipHorizontal" />Flip H
        </button>
        <button className="rail-button" onClick={() => props.onFlip('vertical')} disabled={!canTurn} title="Mirror top to bottom (Y)">
          <Icon name="flipVertical" />Flip V
        </button>
      </div>
      <div className="rail-group view">
        <RailMenu icon="grid" label="Grid" title="Grid settings">
          <GridSettings linesPerMajor={props.gridLinesPerMajor} onChange={props.onGridChange} />
        </RailMenu>
        <RailMenu icon="eye" label="View" title="Choose what is drawn">
          <LayerToggles info={SCHEMATIC_LAYERS} layers={props.layers} onChange={props.onLayersChange} />
        </RailMenu>
      </div>
    </nav>
  )
}
