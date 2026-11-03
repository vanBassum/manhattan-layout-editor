import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatQuantity, unitFor } from '../quantity'
import { nearestIndex, niceTicks, panned, visibleSlice, zoomed, type Range } from './axis'

// A line chart of a few series against one shared x, e.g. voltages against time. Scrolling zooms
// the x-axis around the pointer, dragging pans, a double click shows everything again; the y-axis
// fits what is in view. A crosshair reads every series, and optional cursors A and B are placed by
// clicking.

/**
 * A categorical colour slot. Lines on one axis can cross anywhere, and only the palette's first
 * three hues stay distinguishable from every other, so a chart shows at most three series.
 */
export type SeriesSlot = 1 | 2 | 3

export interface ChartSeries {
  /** As shown in the legend and tooltip, e.g. "V(VOUT)". */
  name: string
  /** One value per x. */
  values: number[]
  /** A series keeps its slot while it is shown, so its colour never changes under the reader. */
  slot: SeriesSlot
}

export interface Cursors {
  a?: number
  b?: number
}

interface LineChartProps {
  /** Rising. */
  x: number[]
  /** Unit of x without prefix, e.g. "s"; the axis picks the prefix. */
  xUnit: string
  /** Symbol of x in the axis title, e.g. "t". */
  xLabel: string
  yUnit: string
  series: ChartSeries[]
  /** Given, clicking places cursor A and Shift+click cursor B. */
  cursors?: { values: Cursors; onChange: (cursor: keyof Cursors, x: number) => void }
  height?: number
}

const MARGIN = { left: 52, right: 12, top: 10, bottom: 40 }
/** How far the pointer must move before a press is a drag (pan) and not a click. */
const DRAG_PX = 3
/** Zoom per pixel of wheel movement: about 1.2× per notch of a usual mouse wheel. */
const ZOOM_PER_WHEEL_PX = 0.002

/** The element's width in pixels, kept up to date as it resizes; 0 until it is measured. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** Tick labels with as many decimals as the step needs, e.g. 2.02 for a step of 0.02. */
const tickLabel = (value: number, step: number) => value.toFixed(Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)))

export function LineChart({ x, xUnit, xLabel, yUnit, series, cursors, height = 300 }: LineChartProps) {
  const { ref, width: measured } = useWidth()
  const svgRef = useRef<SVGSVGElement>(null)
  const full: Range = { min: x[0], max: x[x.length - 1] }
  /** The x-range in view; null shows all of it. */
  const [view, setView] = useState<Range | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const drag = useRef<{ startX: number; startView: Range; moved: boolean } | null>(null)

  // New data starts zoomed out.
  useEffect(() => setView(null), [x])

  // Drawn in real pixels, so text keeps its size however wide the pane is.
  const width = Math.max(measured, 280)
  const right = width - MARGIN.right
  const bottom = height - MARGIN.bottom
  const shown = view ?? full
  const { start, end } = visibleSlice(x, shown)
  const inView = series.flatMap((s) => s.values.slice(start, end))
  const low = Math.min(...inView)
  const high = Math.max(...inView)
  // A flat series still needs a visible span.
  const pad = Math.max((high - low) * 0.08, Math.abs(high) * 1e-3, 1e-9)
  const yRange: Range = { min: low - pad, max: high + pad }
  const toX = (value: number) => MARGIN.left + ((value - shown.min) / (shown.max - shown.min)) * (right - MARGIN.left)
  const toY = (value: number) => bottom - ((value - yRange.min) / (yRange.max - yRange.min)) * (bottom - MARGIN.top)
  const xAt = (clientX: number) => {
    const box = svgRef.current!.getBoundingClientRect()
    return shown.min + ((clientX - box.left - MARGIN.left) / (right - MARGIN.left)) * (shown.max - shown.min)
  }

  // React's wheel listener is passive and cannot keep the page from scrolling, so this one is native.
  const zoomAt = useRef<(event: WheelEvent) => void>(() => {})
  zoomAt.current = (event) => {
    event.preventDefault()
    setView(zoomed(shown, full, Math.exp(event.deltaY * ZOOM_PER_WHEEL_PX), xAt(event.clientX)))
  }
  useEffect(() => {
    const svg = svgRef.current!
    const onWheel = (event: WheelEvent) => zoomAt.current(event)
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startView: shown, moved: false }
  }
  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pressed = drag.current
    if (pressed && Math.abs(event.clientX - pressed.startX) > DRAG_PX) {
      pressed.moved = true
      const perPixel = (pressed.startView.max - pressed.startView.min) / (right - MARGIN.left)
      setView(panned(pressed.startView, full, -(event.clientX - pressed.startX) * perPixel))
      setHovered(null)
      return
    }
    const value = xAt(event.clientX)
    setHovered(value < shown.min || value > shown.max ? null : nearestIndex(x, value))
  }
  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pressed = drag.current
    drag.current = null
    if (!pressed || pressed.moved || !cursors) return
    const value = xAt(event.clientX)
    if (value >= shown.min && value <= shown.max) cursors.onChange(event.shiftKey ? 'b' : 'a', x[nearestIndex(x, value)])
  }

  const xTicks = niceTicks(shown, Math.max(4, Math.round(width / 80)))
  const yTicks = niceTicks(yRange, Math.max(3, Math.round(height / 40)))
  const xUnitPrefix = unitFor(Math.max(Math.abs(shown.min), Math.abs(shown.max)))
  const hoveredX = hovered === null ? 0 : toX(x[hovered])
  // The tooltip sits beside the crosshair, on the side with room.
  const tooltipSide = hoveredX < width / 2 ? { left: hoveredX + 10 } : { right: width - hoveredX + 10 }
  const clipId = useRef(`chart-clip-${Math.random().toString(36).slice(2)}`).current

  return (
    <div className="chart">
      <div className="chart-frame" ref={ref}>
        <svg
          ref={svgRef}
          width={width}
          height={height}
          role="img"
          aria-label={`${series.map((s) => s.name).join(', ')} against ${xLabel}`}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerLeave={() => setHovered(null)}
          onDoubleClick={() => setView(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={MARGIN.left} y={MARGIN.top} width={right - MARGIN.left} height={bottom - MARGIN.top} />
            </clipPath>
          </defs>
          {yTicks.ticks.map((value) => (
            <g key={`y${value}`}>
              <line className="chart-grid" x1={MARGIN.left} x2={right} y1={toY(value)} y2={toY(value)} />
              <text className="chart-tick" x={MARGIN.left - 6} y={toY(value)} textAnchor="end" dominantBaseline="middle">
                {tickLabel(value, yTicks.step)}
              </text>
            </g>
          ))}
          {xTicks.ticks.map((value) => (
            <g key={`x${value}`}>
              <line className="chart-grid" x1={toX(value)} x2={toX(value)} y1={MARGIN.top} y2={bottom} />
              <text className="chart-tick" x={toX(value)} y={bottom + 16} textAnchor="middle">
                {tickLabel(value / xUnitPrefix.scale, xTicks.step / xUnitPrefix.scale)}
              </text>
            </g>
          ))}
          <rect className="chart-border" x={MARGIN.left} y={MARGIN.top} width={right - MARGIN.left} height={bottom - MARGIN.top} />
          <text className="chart-axis-title" x={14} y={(MARGIN.top + bottom) / 2} textAnchor="middle" dominantBaseline="middle">
            {yUnit}
          </text>
          <text className="chart-axis-title" x={(MARGIN.left + right) / 2} y={height - 4} textAnchor="middle">
            {xLabel} ({xUnitPrefix.prefix}{xUnit})
          </text>
          <g clipPath={`url(#${clipId})`}>
            {series.map((s) => (
              <path
                key={s.name}
                className={`chart-line series-${s.slot}`}
                d={s.values
                  .slice(start, end)
                  .map((value, k) => `${k ? 'L' : 'M'}${toX(x[start + k]).toFixed(1)} ${toY(value).toFixed(1)}`)
                  .join('')}
              />
            ))}
            {cursors &&
              (['a', 'b'] as const).map((cursor) => {
                const value = cursors.values[cursor]
                if (value === undefined) return null
                return (
                  <g key={cursor}>
                    <line className="chart-cursor" x1={toX(value)} x2={toX(value)} y1={MARGIN.top} y2={bottom} />
                    <text className="chart-cursor-label" x={toX(value) + 4} y={MARGIN.top + 12}>
                      {cursor.toUpperCase()}
                    </text>
                  </g>
                )
              })}
            {hovered !== null && (
              <g>
                <line className="chart-crosshair" x1={hoveredX} x2={hoveredX} y1={MARGIN.top} y2={bottom} />
                {series.map((s) => (
                  <circle key={s.name} className={`chart-dot series-${s.slot}`} cx={hoveredX} cy={toY(s.values[hovered])} r={4} />
                ))}
              </g>
            )}
          </g>
        </svg>
        {hovered !== null && (
          <div className="chart-tooltip" style={tooltipSide}>
            <div className="chart-tooltip-title">
              {xLabel} = {formatQuantity(x[hovered], xUnit)}
            </div>
            {series.map((s) => (
              <div key={s.name}>
                <span className={`dot-key series-${s.slot}`} aria-hidden="true" />
                {s.name} = <strong>{formatQuantity(s.values[hovered], yUnit)}</strong>
              </div>
            ))}
          </div>
        )}
        {view && (
          <button className="chart-reset" onClick={() => setView(null)} title="Show everything (or double-click the chart)">
            Reset zoom
          </button>
        )}
      </div>
      <ul className="chart-legend">
        {series.map((s) => (
          <li key={s.name}>
            <span className={`line-key series-${s.slot}`} aria-hidden="true" />
            {s.name}
          </li>
        ))}
      </ul>
    </div>
  )
}
