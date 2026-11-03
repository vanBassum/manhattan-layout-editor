import { BUILD_STYLES, findBuildStyle } from '../model/buildStyles'
import { Icon } from './icons'
import { Section } from './panels'
import type { Rect, Settings } from '../model/types'

const SNAP_OPTIONS = [0, 0.25, 0.5, 1, 1.27, 2.54]

interface MmInputProps {
  value: number
  /** The smallest value; anything below it, or not a number, becomes this. */
  min: number
  step: number
  onChange: (value: number) => void
}

function MmInput({ value, min, step, onChange }: MmInputProps) {
  return (
    <span className="unit-input">
      <input type="number" min={min} step={step} value={value} onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))} />
      mm
    </span>
  )
}

interface PcbSettingsProps {
  settings: Settings
  onChange: (changes: Partial<Settings>) => void
  onResetToGrid: () => void
  /** The bounds of all copper, if there is any. */
  boardSize: Rect | null
}

/** The PCB panel's Board settings section. */
export function PcbSettings({ settings, onChange, onResetToGrid, boardSize }: PcbSettingsProps) {
  const buildStyle = findBuildStyle(settings.buildStyle)
  return (
    <Section title="Board settings">
      <div className="settings">
        <label title={buildStyle.description}>
          Build style
          <select value={settings.buildStyle} title={buildStyle.description} onChange={(e) => onChange({ buildStyle: findBuildStyle(e.target.value).id })}>
            {BUILD_STYLES.map((s) => (
              <option key={s.id} value={s.id} title={s.description}>{s.label}</option>
            ))}
          </select>
        </label>
        <label>
          Snap
          <select value={settings.snap} onChange={(e) => onChange({ snap: Number(e.target.value) })}>
            {SNAP_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === 0 ? 'off' : `${s} mm`}</option>
            ))}
          </select>
        </label>
        <label>
          Isolation
          <MmInput value={settings.isolation} min={0.05} step={0.05} onChange={(isolation) => onChange({ isolation })} />
        </label>
        <button className="reset-grid" onClick={onResetToGrid}><Icon name="grid" />Reset to grid</button>
        {boardSize && (
          <p className="board-size">Board {boardSize.w.toFixed(1)} × {boardSize.h.toFixed(1)} mm</p>
        )}
      </div>
    </Section>
  )
}
