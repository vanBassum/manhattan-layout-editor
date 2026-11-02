import type { ReactNode } from 'react'
import { componentGeometry } from './layout'
import type { NetComponent, Point } from './types'

// Schematic symbols in mm, centered on 0,0, with every pin end on the 2.54 mm (0.1 inch) grid.
// The pin numbering follows KiCad's symbol library (diode: 1 = cathode, electrolytic: 1 = plus).

export interface SymbolPin extends Point {
  /** Unit vector pointing away from the symbol; a wire or net label continues this way. */
  dx: number
  dy: number
}

export interface SchematicSymbol {
  /** One per component pin, in the component's pin order. */
  pins: SymbolPin[]
  body: ReactNode
  /** Where the reference and value go: top-left of the label block. */
  label: Point
}

const left = (x: number, y = 0): SymbolPin => ({ x, y, dx: -1, dy: 0 })
const right = (x: number, y = 0): SymbolPin => ({ x, y, dx: 1, dy: 0 })
const up = (x: number, y: number): SymbolPin => ({ x, y, dx: 0, dy: -1 })
const down = (x: number, y: number): SymbolPin => ({ x, y, dx: 0, dy: 1 })

function Line({ points }: { points: [number, number][] }) {
  return <polyline className="sch-line" points={points.map((p) => p.join(',')).join(' ')} />
}

/** Filled arrow head with its tip at `tip`, pointing along (dx, dy). */
function ArrowHead({ tip, dx, dy, size = 1 }: { tip: Point; dx: number; dy: number; size?: number }) {
  const length = Math.hypot(dx, dy)
  const ux = dx / length
  const uy = dy / length
  const back = { x: tip.x - ux * size, y: tip.y - uy * size }
  const half = size * 0.4
  const points = [
    [tip.x, tip.y],
    [back.x - uy * half, back.y + ux * half],
    [back.x + uy * half, back.y - ux * half],
  ]
  return <polygon className="sch-fill" points={points.map((p) => p.join(',')).join(' ')} />
}

function resistor(): SchematicSymbol {
  return {
    pins: [left(-5.08), right(5.08)],
    body: (
      <>
        <Line points={[[-5.08, 0], [-2.54, 0]]} />
        <Line points={[[2.54, 0], [5.08, 0]]} />
        <rect className="sch-resistor" x={-2.54} y={-0.9} width={5.08} height={1.8} />
      </>
    ),
    label: { x: -2.54, y: -4.2 },
  }
}

function trimmer(): SchematicSymbol {
  const base = resistor()
  return {
    ...base,
    // Ends on 1 and 3, the wiper on 2.
    pins: [base.pins[0], down(0, 5.08), base.pins[1]],
    body: (
      <>
        {base.body}
        <Line points={[[0, 5.08], [0, 1.9]]} />
        <ArrowHead tip={{ x: 0, y: 0.9 }} dx={0} dy={-1} />
      </>
    ),
  }
}

function capacitor(polarized: boolean): SchematicSymbol {
  return {
    pins: [left(-2.54), right(2.54)],
    body: (
      <>
        <Line points={[[-2.54, 0], [-0.6, 0]]} />
        <Line points={[[0.6, 0], [2.54, 0]]} />
        <rect className={polarized ? 'sch-plate-open' : 'sch-fill'} x={-0.95} y={-1.9} width={0.5} height={3.8} />
        <rect className="sch-fill" x={0.45} y={-1.9} width={0.5} height={3.8} />
        {polarized && <text className="sch-pin-mark" x={-1.9} y={-1.1} textAnchor="middle">+</text>}
      </>
    ),
    label: { x: -2.54, y: -5.2 },
  }
}

function diode(led: boolean): SchematicSymbol {
  return {
    // Cathode (pin 1) on the right, so current flows left to right.
    pins: [right(5.08), left(-5.08)],
    body: (
      <>
        <Line points={[[-5.08, 0], [-1.27, 0]]} />
        <Line points={[[1.27, 0], [5.08, 0]]} />
        <polygon className="sch-fill" points="-1.27,-1.27 -1.27,1.27 1.27,0" />
        <rect className="sch-fill" x={1.1} y={-1.27} width={0.35} height={2.54} />
        {led && (
          <>
            <Line points={[[-0.2, -1.5], [0.9, -2.6]]} />
            <ArrowHead tip={{ x: 1.3, y: -3 }} dx={1} dy={-1} size={0.7} />
            <Line points={[[0.8, -1.5], [1.9, -2.6]]} />
            <ArrowHead tip={{ x: 2.3, y: -3 }} dx={1} dy={-1} size={0.7} />
          </>
        )}
      </>
    ),
    label: { x: -2.54, y: led ? -5.6 : -4.2 },
  }
}

type TransistorPin = 'B' | 'C' | 'E'

/**
 * A guess until parts carry real pin data: TO-92 as the common BC5xx (C B E), TO-126 as BD13x
 * (E C B), anything else as 2N390x (E B C).
 */
function transistorPinOrder(component: NetComponent): TransistorPin[] {
  const shape = componentGeometry(component).shape
  if (shape === 'to92') return ['C', 'B', 'E']
  if (shape === 'to126') return ['E', 'C', 'B']
  return ['E', 'B', 'C']
}

const isPnp = (value: string) => /BC55[6-9]|BC32[78]|BC640|BD1(3[02468]|40)|2N3906|2N2907|TIP(30|32|42)|2SA/i.test(value)

function transistor(component: NetComponent): SchematicSymbol {
  const pnp = isPnp(component.value)
  // The emitter goes to the more positive side: down for NPN, up for PNP. Its arrow points out of
  // the transistor for NPN and into it for PNP.
  const pinAt: Record<TransistorPin, SymbolPin> = pnp
    ? { B: left(-5.08), C: down(2.54, 5.08), E: up(2.54, -5.08) }
    : { B: left(-5.08), C: up(2.54, -5.08), E: down(2.54, 5.08) }
  const emitterSide = pnp ? -1 : 1
  const arrow = pnp ? { tip: { x: -0.6, y: -1.1 }, dx: -1, dy: 0.47 } : { tip: { x: 2.0, y: 2.29 }, dx: 1, dy: 0.47 }
  return {
    pins: transistorPinOrder(component).map((role) => pinAt[role]),
    body: (
      <>
        <circle className="sch-outline" cx={0.64} cy={0} r={3.4} />
        <Line points={[[-5.08, 0], [-1.27, 0]]} />
        <rect className="sch-fill" x={-1.52} y={-2.03} width={0.5} height={4.06} />
        <Line points={[[-1.27, -0.76 * emitterSide], [2.54, -2.54 * emitterSide], [2.54, -5.08 * emitterSide]]} />
        <Line points={[[-1.27, 0.76 * emitterSide], [2.54, 2.54 * emitterSide], [2.54, 5.08 * emitterSide]]} />
        <ArrowHead {...arrow} />
      </>
    ),
    label: { x: 4.6, y: -1.4 },
  }
}

/** A box with pins on the left and right: ICs, connectors and anything not recognised. */
function box(component: NetComponent): SchematicSymbol {
  const pinCount = component.pins.length
  const leftCount = Math.ceil(pinCount / 2)
  const rows = Math.max(leftCount, 1)
  // Whole grid steps from the origin, so an even number of rows sits half a step off-centre.
  const pinY = (row: number) => (row - Math.floor((rows - 1) / 2)) * 2.54
  const top = pinY(0) - 2.54
  const height = (rows + 1) * 2.54
  const pins = component.pins.map((_, k) => (k < leftCount ? left(-7.62, pinY(k)) : right(7.62, pinY(k - leftCount))))
  return {
    pins,
    body: (
      <>
        <rect className="sch-box" x={-5.08} y={top} width={10.16} height={height} />
        {pins.map((pin, k) => (
          <g key={k}>
            <Line points={[[pin.x, pin.y], [pin.x - pin.dx * 2.54, pin.y]]} />
            <text className="sch-pin-number" x={pin.x - pin.dx * 3.1} y={pin.y + 0.45} textAnchor={pin.dx < 0 ? 'start' : 'end'}>
              {component.pins[k].number}
            </text>
          </g>
        ))}
      </>
    ),
    label: { x: -5.08, y: top - 3.2 },
  }
}

/**
 * Electrolytics come in a round can: EasyEDA gives a body diameter ("CAP-TH_BD8.0-..."), KiCad
 * names them "CP_..." or "...Elec...". Box footprints with length and width are film or ceramic.
 */
const isElectrolytic = (footprint: string) => /(^|[-_])BD\d|^CP_|ELEC|POL/i.test(footprint)

export function symbolFor(component: NetComponent): SchematicSymbol {
  const prefix = component.ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? ''
  const pinCount = component.pins.length
  const geometry = componentGeometry(component)
  if (pinCount === 3 && (geometry.shape === 'trimmer' || /^(RV|VR|P|POT)$/.test(prefix))) return trimmer()
  if (pinCount === 3 && prefix === 'Q') return transistor(component)
  if (pinCount === 2) {
    // RL: a load resistor.
    if (prefix === 'R' || prefix === 'RL') return resistor()
    if (prefix === 'C') return capacitor(isElectrolytic(component.footprint))
    if (geometry.led || prefix === 'LED') return diode(true)
    if (prefix === 'D') return diode(false)
  }
  return box(component)
}
