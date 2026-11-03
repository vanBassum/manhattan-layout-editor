import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { formatQuantity, unitFor } from './quantity'

// Voltage against time for up to three nets on one axis, with a crosshair that reads every trace
// and two cursors, A and B, placed by clicking.

export type SeriesSlot = 1 | 2 | 3

export interface ScopeTrace {
  net: string
  volts: number[]
  /** The categorical colour slot; a net keeps its slot while it is shown. */
  series: SeriesSlot
}

export interface Cursors {
  a?: number
  b?: number
}

interface ScopePlotProps {
  /** Seconds, rising; every trace has one value per time. */
  time: number[]
  traces: ScopeTrace[]
  cursors: Cursors
  onCursor: (cursor: keyof Cursors, seconds: number) => void
}

const HEIGHT = 300
const MARGIN = { left: 52, right: 12, top: 10, bottom: 40 }

/** About `count` round tick values (steps of 1, 2 or 5 times a power of ten) covering min..max. */
function niceTicks(min: number, max: number, count: number): number[] {
  const rough = (max - min) / count
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((f) => f * power).find((s) => s >= rough)!
  const ticks: number[] = []
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) ticks.push(tick)
  return ticks
}

/** The index of the time nearest `seconds`; `time` is sorted. */
function nearestIndex(time: number[], seconds: number): number {
  let low = 0
  let high = time.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (time[middle] < seconds) low = middle
    else high = middle
  }
  return seconds - time[low] < time[high] - seconds ? low : high
}

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

export function ScopePlot({ time, traces, cursors, onCursor }: ScopePlotProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const { ref, width: measured } = useWidth()
  // Drawn in real pixels, so text keeps its size however wide the pane is.
  const width = Math.max(measured, 280)
  const right = width - MARGIN.right
  const bottom = HEIGHT - MARGIN.bottom
  const end = time[time.length - 1]
  const all = traces.flatMap((t) => t.volts)
  const low = Math.min(...all)
  const high = Math.max(...all)
  // A flat trace still needs a visible span.
  const pad = Math.max((high - low) * 0.08, 0.05)
  const vMin = low - pad
  const vMax = high + pad
  const x = (seconds: number) => MARGIN.left + (seconds / end) * (right - MARGIN.left)
  const y = (volts: number) => bottom - ((volts - vMin) / (vMax - vMin)) * (bottom - MARGIN.top)
  const timeUnit = unitFor(end)

  /** The time under the pointer, or undefined outside the plot. */
  const secondsAt = (event: PointerEvent<SVGSVGElement> | MouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const seconds = ((event.clientX - box.left - MARGIN.left) / (right - MARGIN.left)) * end
    return seconds < 0 || seconds > end ? undefined : seconds
  }
  const hover = (event: PointerEvent<SVGSVGElement>) => {
    const seconds = secondsAt(event)
    setHovered(seconds === undefined ? null : nearestIndex(time, seconds))
  }
  const placeCursor = (event: MouseEvent<SVGSVGElement>) => {
    const seconds = secondsAt(event)
    if (seconds !== undefined) onCursor(event.shiftKey ? 'b' : 'a', time[nearestIndex(time, seconds)])
  }

  // The tooltip sits beside the crosshair, on the side with room.
  const hoveredX = hovered === null ? 0 : x(time[hovered])
  const tooltipSide = hoveredX < width / 2 ? { left: hoveredX + 10 } : { right: width - hoveredX + 10 }

  return (
    <div className="scope">
      <div className="scope-frame" ref={ref}>
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Voltage of ${traces.map((t) => t.net).join(', ')} over time`}
          onPointerMove={hover}
          onPointerLeave={() => setHovered(null)}
          onClick={placeCursor}
        >
          {niceTicks(vMin, vMax, 8).map((v) => (
            <g key={`v${v}`}>
              <line className="scope-grid" x1={MARGIN.left} x2={right} y1={y(v)} y2={y(v)} />
              <text className="scope-tick" x={MARGIN.left - 6} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {Number(v.toPrecision(3))}
              </text>
            </g>
          ))}
          {niceTicks(0, end, Math.max(4, Math.round(width / 70))).map((t) => (
            <g key={`t${t}`}>
              <line className="scope-grid" x1={x(t)} x2={x(t)} y1={MARGIN.top} y2={bottom} />
              <text className="scope-tick" x={x(t)} y={bottom + 16} textAnchor="middle">
                {Number((t / timeUnit.scale).toPrecision(3))}
              </text>
            </g>
          ))}
          <rect className="scope-border" x={MARGIN.left} y={MARGIN.top} width={right - MARGIN.left} height={bottom - MARGIN.top} />
          <text className="scope-axis-title" x={14} y={(MARGIN.top + bottom) / 2} textAnchor="middle" dominantBaseline="middle">V</text>
          <text className="scope-axis-title" x={(MARGIN.left + right) / 2} y={HEIGHT - 4} textAnchor="middle">
            t ({timeUnit.prefix}s)
          </text>
          {traces.map((t) => (
            <path
              key={t.net}
              className={`scope-trace series-${t.series}`}
              d={t.volts.map((v, k) => `${k ? 'L' : 'M'}${x(time[k]).toFixed(1)} ${y(v).toFixed(1)}`).join('')}
            />
          ))}
          {(['a', 'b'] as const).map((cursor) =>
            cursors[cursor] === undefined ? null : (
              <g key={cursor}>
                <line className="scope-cursor" x1={x(cursors[cursor]!)} x2={x(cursors[cursor]!)} y1={MARGIN.top} y2={bottom} />
                <text className="scope-cursor-label" x={x(cursors[cursor]!) + 4} y={MARGIN.top + 12}>
                  {cursor.toUpperCase()}
                </text>
              </g>
            ),
          )}
          {hovered !== null && (
            <g>
              <line className="scope-crosshair" x1={hoveredX} x2={hoveredX} y1={MARGIN.top} y2={bottom} />
              {traces.map((t) => (
                <circle key={t.net} className={`scope-dot series-${t.series}`} cx={hoveredX} cy={y(t.volts[hovered])} r={4} />
              ))}
            </g>
          )}
        </svg>
        {hovered !== null && (
          <div className="scope-tooltip" style={tooltipSide}>
            <div className="scope-tooltip-title">t = {formatQuantity(time[hovered], 's')}</div>
            {traces.map((t) => (
              <div key={t.net}>
                <span className={`dot-key series-${t.series}`} aria-hidden="true" />
                {t.net} = <strong>{formatQuantity(t.volts[hovered], 'V')}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <ul className="scope-legend">
        {traces.map((t) => (
          <li key={t.net}>
            <span className={`line-key series-${t.series}`} aria-hidden="true" />V({t.net})
          </li>
        ))}
      </ul>
    </div>
  )
}
