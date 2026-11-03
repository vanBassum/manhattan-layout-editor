import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { formatQuantity, unitFor } from './quantity'

// A small oscilloscope: voltage against time for a few nets. Each net gets a lane with its own
// voltage scale, like a scope channel, so a small input and a large output both show their shape;
// the lanes share the time axis and one crosshair that reads every trace.

export interface ScopeTrace {
  net: string
  volts: number[]
  /** The categorical colour slot, so a net keeps its colour whatever else is shown. */
  series: 1 | 2
}

interface ScopePlotProps {
  /** Seconds, rising; every trace has one value per time. */
  time: number[]
  traces: ScopeTrace[]
}

const LANE_GAP = 10
const TIME_AXIS_HEIGHT = 18
const LEFT = 44
const RIGHT_MARGIN = 8

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

/** A trace's lane: where it sits and how its volts map onto it. */
function laneOf(trace: ScopeTrace, index: number, laneHeight: number) {
  const top = index * (laneHeight + LANE_GAP)
  const bottom = top + laneHeight
  const low = Math.min(...trace.volts)
  const high = Math.max(...trace.volts)
  // A flat trace still needs a visible span.
  const pad = Math.max((high - low) * 0.1, 0.05)
  const vMin = low - pad
  const vMax = high + pad
  return { top, bottom, vMin, vMax, y: (volts: number) => bottom - ((volts - vMin) / (vMax - vMin)) * laneHeight }
}

export function ScopePlot({ time, traces }: ScopePlotProps) {
  const [hovered, setHovered] = useState<number | null>(null)
  const { ref, width: measured } = useWidth()
  // Drawn in real pixels, so text keeps its size however wide the pane is.
  const width = Math.max(measured, 240)
  const right = width - RIGHT_MARGIN
  const laneHeight = Math.min(Math.max(width * 0.25, 80), 220)
  const end = time[time.length - 1]
  const lanes = traces.map((trace, k) => laneOf(trace, k, laneHeight))
  const plotBottom = lanes[lanes.length - 1].bottom
  const height = plotBottom + TIME_AXIS_HEIGHT
  const x = (seconds: number) => LEFT + (seconds / end) * (right - LEFT)
  const timeUnit = unitFor(end)

  const hover = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const plotX = ((event.clientX - box.left) / box.width) * width
    const seconds = ((plotX - LEFT) / (right - LEFT)) * end
    setHovered(seconds < 0 || seconds > end ? null : nearestIndex(time, seconds))
  }

  // The tooltip sits beside the crosshair, on the side with room.
  const hoveredX = hovered === null ? 0 : x(time[hovered])
  const tooltipSide = hoveredX < width / 2 ? { left: `calc(${(hoveredX / width) * 100}% + 6px)` } : { right: `calc(${(1 - hoveredX / width) * 100}% + 6px)` }

  return (
    <div className="scope">
      <div className="scope-legend">
        {traces.map((t) => (
          <span key={t.net}>
            <span className={`line-key series-${t.series}`} aria-hidden="true" />
            {t.net}
          </span>
        ))}
      </div>
      <div className="scope-frame" ref={ref}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Voltage of ${traces.map((t) => t.net).join(' and ')} over time`}
          onPointerMove={hover}
          onPointerLeave={() => setHovered(null)}
        >
          {traces.map((trace, k) => {
            const lane = lanes[k]
            const path = trace.volts.map((v, i) => `${i ? 'L' : 'M'}${x(time[i]).toFixed(1)} ${lane.y(v).toFixed(1)}`).join('')
            return (
              <g key={trace.net}>
                {niceTicks(lane.vMin, lane.vMax, Math.max(3, Math.round(laneHeight / 40))).map((v) => (
                  <g key={v}>
                    <line className="scope-grid" x1={LEFT} x2={right} y1={lane.y(v)} y2={lane.y(v)} />
                    <text className="scope-tick" x={LEFT - 3} y={lane.y(v)} textAnchor="end" dominantBaseline="middle">
                      {Number(v.toPrecision(3))}
                    </text>
                  </g>
                ))}
                <line className="scope-axis" x1={LEFT} x2={LEFT} y1={lane.top} y2={lane.bottom} />
                <path className={`scope-trace series-${trace.series}`} d={path} />
              </g>
            )
          })}
          <line className="scope-axis" x1={LEFT} x2={right} y1={plotBottom} y2={plotBottom} />
          {niceTicks(0, end, Math.max(4, Math.round(width / 90))).map((t) => (
            <text key={t} className="scope-tick" x={x(t)} y={height - 3} textAnchor="middle">
              {Number((t / timeUnit.scale).toPrecision(3))}
            </text>
          ))}
          <text className="scope-tick" x={LEFT - 8} y={height - 3} textAnchor="end">
            {timeUnit.prefix}s
          </text>
          <text className="scope-tick" x={4} y={11}>V</text>
          {hovered !== null && <line className="scope-crosshair" x1={hoveredX} x2={hoveredX} y1={0} y2={plotBottom} />}
        </svg>
        {hovered !== null && (
          <div className="scope-tooltip" style={tooltipSide}>
            <div className="muted">{formatQuantity(time[hovered], 's')}</div>
            {traces.map((t) => (
              <div key={t.net}>
                <span className={`line-key series-${t.series}`} aria-hidden="true" />
                <strong>{formatQuantity(t.volts[hovered], 'V')}</strong> <span className="muted">{t.net}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
