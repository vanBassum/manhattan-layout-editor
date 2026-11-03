import type { KeyboardEvent, PointerEvent } from 'react'
import { SPLIT_RANGE } from './preferences'

interface PaneDividerProps {
  /** The left pane's share of the width the two panes have together. */
  share: number
  onChange: (share: number) => void
}

const clamp = (share: number) => Math.min(SPLIT_RANGE.max, Math.max(SPLIT_RANGE.min, share))

/** The bar between the schematic and the right pane: drag it, or use the arrow keys, to share the width. */
export function PaneDivider({ share, onChange }: PaneDividerProps) {
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const divider = event.currentTarget
    // The panes' container: the share is measured across its width.
    const panes = divider.parentElement!.getBoundingClientRect()
    divider.setPointerCapture(event.pointerId)
    const move = (e: globalThis.PointerEvent) => onChange(clamp((e.clientX - panes.left) / panes.width))
    const stop = () => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', stop)
      divider.removeEventListener('pointercancel', stop)
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', stop)
    divider.addEventListener('pointercancel', stop)
  }

  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : 0
    if (step === 0) return
    event.preventDefault()
    onChange(clamp(share + step))
  }

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the schematic and the right pane"
      aria-valuemin={SPLIT_RANGE.min * 100}
      aria-valuemax={SPLIT_RANGE.max * 100}
      aria-valuenow={Math.round(share * 100)}
      tabIndex={0}
      onPointerDown={startDrag}
      onKeyDown={nudge}
    />
  )
}
