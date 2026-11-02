import { useEffect, useId, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { Rect } from './types'

// Pan, zoom, grid and rulers shared by the layout canvas and the schematic view.

/** screen = world * scale + offset; scale is pixels per world unit (mm). */
export interface View {
  scale: number
  ox: number
  oy: number
}

export interface Size {
  width: number
  height: number
}

const MIN_SCALE = 0.5
const MAX_SCALE = 200

/** Tracks the svg's size and zooms around the pointer on the mouse wheel. */
export function useViewport(svgRef: RefObject<SVGSVGElement | null>) {
  const [view, setView] = useState<View>({ scale: 5, ox: 40, oy: 40 })
  const [size, setSize] = useState<Size>({ width: 800, height: 600 })

  useLayoutEffect(() => {
    const svg = svgRef.current!
    const observer = new ResizeObserver(() => {
      const r = svg.getBoundingClientRect()
      setSize({ width: r.width, height: r.height })
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [svgRef])

  // React registers wheel listeners as passive, so preventDefault needs a native listener.
  useEffect(() => {
    const svg = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const factor = Math.exp(-e.deltaY * 0.0015)
      setView((v) => {
        const scale = Math.min(Math.max(v.scale * factor, MIN_SCALE), MAX_SCALE)
        const k = scale / v.scale
        return { scale, ox: mx - (mx - v.ox) * k, oy: my - (my - v.oy) * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [svgRef])

  /** Zooms and pans so `bounds` (world units) fills the view, centered. */
  const fitTo = (bounds: Rect) => {
    const { width, height } = svgRef.current!.getBoundingClientRect()
    const scale = Math.min(width / bounds.w, height / bounds.h)
    setView({
      scale,
      ox: (width - bounds.w * scale) / 2 - bounds.x * scale,
      oy: (height - bounds.h * scale) / 2 - bounds.y * scale,
    })
  }

  return { view, setView, size, fitTo }
}

/** The part of the world that is on screen. */
export function visibleArea(view: View, size: Size): Rect {
  return { x: -view.ox / view.scale, y: -view.oy / view.scale, w: size.width / view.scale, h: size.height / view.scale }
}

const MIN_GRID_SPACING_PX = 8

/** Finest pitch whose lines stay far enough apart to read at this zoom. */
export function gridPitch(scale: number, pitches: readonly number[]): number {
  return pitches.find((pitch) => pitch * scale >= MIN_GRID_SPACING_PX) ?? pitches[pitches.length - 1]
}

/** Dashed fine grid with every fifth line solid, plus the origin axes when `axes` is set. Goes inside the world transform. */
export function ViewportGrid({ view, size, pitch, axes = true }: { view: View; size: Size; pitch: number; axes?: boolean }) {
  // Unique per instance: a hidden canvas for screenshots can be in the document at the same time.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const px = 1 / view.scale
  const visible = visibleArea(view, size)
  return (
    <>
      <defs>
        <pattern id={`${id}-minor`} width={pitch} height={pitch} patternUnits="userSpaceOnUse">
          <path
            d={`M ${pitch} 0 L 0 0 0 ${pitch}`}
            fill="none"
            className="grid-minor"
            strokeWidth={px}
            strokeDasharray={`${2 * px} ${3 * px}`}
          />
        </pattern>
        <pattern id={`${id}-major`} width={5 * pitch} height={5 * pitch} patternUnits="userSpaceOnUse">
          <path d={`M ${5 * pitch} 0 L 0 0 0 ${5 * pitch}`} fill="none" className="grid-major" strokeWidth={px} />
        </pattern>
      </defs>
      <g className="grid">
        <rect x={visible.x} y={visible.y} width={visible.w} height={visible.h} fill={`url(#${id}-minor)`} />
        <rect x={visible.x} y={visible.y} width={visible.w} height={visible.h} fill={`url(#${id}-major)`} />
        {axes && (
          <>
            <line x1={visible.x} y1={0} x2={visible.x + visible.w} y2={0} className="axis" strokeWidth={px} />
            <line x1={0} y1={visible.y} x2={0} y2={visible.y + visible.h} className="axis" strokeWidth={px} />
          </>
        )}
      </g>
    </>
  )
}

const RULER_PX = 18

/** Tick positions (mm) of one ruler: every grid pitch inside [from, to]. */
function rulerTicks(from: number, to: number, pitch: number): number[] {
  const ticks: number[] = []
  for (let k = Math.ceil(from / pitch); k * pitch <= to; k++) ticks.push(k * pitch)
  return ticks
}

/**
 * Millimetre rulers along the top and left edge, in screen space so they stay put while the
 * board pans under them. Labels sit on the solid (every fifth) grid lines.
 */
export function Rulers({ view, size, pitch }: { view: View; size: Size; pitch: number }) {
  const { width, height } = size
  const toScreenX = (mm: number) => view.ox + mm * view.scale
  const toScreenY = (mm: number) => view.oy + mm * view.scale
  const isMajor = (mm: number) => Math.abs(mm / (5 * pitch) - Math.round(mm / (5 * pitch))) < 1e-6
  const label = (mm: number) => String(Math.round(mm * 100) / 100)
  const xTicks = rulerTicks(-view.ox / view.scale, (width - view.ox) / view.scale, pitch)
  const yTicks = rulerTicks(-view.oy / view.scale, (height - view.oy) / view.scale, pitch)
  return (
    <g className="ruler" pointerEvents="none">
      <rect x={0} y={0} width={width} height={RULER_PX} />
      <rect x={0} y={0} width={RULER_PX} height={height} />
      {xTicks.map((mm) => {
        const x = toScreenX(mm)
        if (x < RULER_PX) return null
        return (
          <g key={`x${mm}`}>
            <line x1={x} y1={RULER_PX} x2={x} y2={RULER_PX - (isMajor(mm) ? 8 : 4)} />
            {isMajor(mm) && <text x={x + 2} y={9}>{label(mm)}</text>}
          </g>
        )
      })}
      {yTicks.map((mm) => {
        const y = toScreenY(mm)
        if (y < RULER_PX) return null
        return (
          <g key={`y${mm}`}>
            <line x1={RULER_PX} y1={y} x2={RULER_PX - (isMajor(mm) ? 8 : 4)} y2={y} />
            {isMajor(mm) && (
              <text x={9} y={y + 2} transform={`rotate(-90 9 ${y + 2})`}>{label(mm)}</text>
            )}
          </g>
        )
      })}
      <text x={3} y={12} className="ruler-unit">mm</text>
    </g>
  )
}
