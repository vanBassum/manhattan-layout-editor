import { useEffect, useId, useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import { inflate } from '../geometry'
import type { Point, Rect } from '../types'

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
/** Room (mm) left around the content when the view is fitted to it. */
const FIT_MARGIN = 5

/** A press that moves less than this (screen pixels) is a click, not a drag. */
export const CLICK_TOLERANCE_PX = 3

/** Panning: the pointer's screen position and the view at the press. */
export interface PanDrag {
  kind: 'pan'
  startX: number
  startY: number
  view: View
}

/**
 * A selection rectangle from `start` (world), pressed at screen position startX, startY. With
 * `additive` (Shift/Ctrl), it adds to the selection.
 */
export interface MarqueeDrag {
  kind: 'marquee'
  start: Point
  startX: number
  startY: number
  additive: boolean
}

/** The view moved along with the pointer since the pan started. */
export function pannedView(drag: PanDrag, e: { clientX: number; clientY: number }): View {
  return { ...drag.view, ox: drag.view.ox + e.clientX - drag.startX, oy: drag.view.oy + e.clientY - drag.startY }
}

/** The world point (mm) under the pointer. */
export function screenToWorld(svg: SVGSVGElement, view: View, e: { clientX: number; clientY: number }): Point {
  const r = svg.getBoundingClientRect()
  return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale }
}

/**
 * Tracks the svg's size and zooms around the pointer on the mouse wheel. Each new `fitRequest` fits
 * the view to `contentBounds()`; 0 asks for no fit, for a canvas that keeps the view it starts with.
 */
export function useViewport(svgRef: RefObject<SVGSVGElement | null>, fitRequest: number, contentBounds: () => Rect | null) {
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

  useEffect(() => {
    if (fitRequest === 0) return
    const bounds = contentBounds()
    if (bounds) fitTo(inflate(bounds, FIT_MARGIN))
    // Only refit when explicitly requested, not on every edit.
  }, [fitRequest])

  return { view, setView, size }
}

/** The part of the world that is on screen. */
export function visibleArea(view: View, size: Size): Rect {
  return { x: -view.ox / view.scale, y: -view.oy / view.scale, w: size.width / view.scale, h: size.height / view.scale }
}

const MIN_GRID_SPACING_PX = 8

/** Grid pitches from `finest` up, each the solid-line spacing of the one before, so zooming out keeps the solid lines. */
export function gridPitches(finest: number, linesPerMajor: number): number[] {
  return [finest, finest * linesPerMajor, finest * linesPerMajor ** 2, finest * linesPerMajor ** 3]
}

/** Finest pitch whose lines stay far enough apart to read at this zoom. */
export function gridPitch(scale: number, pitches: readonly number[]): number {
  return pitches.find((pitch) => pitch * scale >= MIN_GRID_SPACING_PX) ?? pitches[pitches.length - 1]
}

/**
 * Dashed fine grid with every `linesPerMajor`-th line solid, plus the origin axes when `axes` is set.
 * Goes inside the world transform.
 */
export function ViewportGrid({
  view,
  size,
  pitch,
  linesPerMajor,
  axes = true,
}: {
  view: View
  size: Size
  pitch: number
  linesPerMajor: number
  axes?: boolean
}) {
  // Unique per instance: a hidden canvas for screenshots can be in the document at the same time.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const px = 1 / view.scale
  const visible = visibleArea(view, size)
  const major = linesPerMajor * pitch
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
        <pattern id={`${id}-major`} width={major} height={major} patternUnits="userSpaceOnUse">
          <path d={`M ${major} 0 L 0 0 0 ${major}`} fill="none" className="grid-major" strokeWidth={px} />
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
 * board pans under them. Labels sit on the solid grid lines.
 */
export function Rulers({ view, size, pitch, linesPerMajor }: { view: View; size: Size; pitch: number; linesPerMajor: number }) {
  const { width, height } = size
  const toScreenX = (mm: number) => view.ox + mm * view.scale
  const toScreenY = (mm: number) => view.oy + mm * view.scale
  const major = linesPerMajor * pitch
  const isMajor = (mm: number) => Math.abs(mm / major - Math.round(mm / major)) < 1e-6
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
