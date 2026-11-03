import { generatedGeometry } from './footprintTemplates'
import type { NetComponent, PinDefinition, Point, SymbolDefinition, SymbolGraphic } from './types'

// Built-in schematic symbols: templates a project copies into its own component definitions.
// All in mm, centered on 0,0, with every pin end on the 2.54 mm (0.1 inch) grid. The pin
// numbering follows KiCad's symbol library (diode: 1 = cathode, electrolytic: 1 = plus).

type Direction = Pick<PinDefinition, 'dx' | 'dy'>
const LEFT: Direction = { dx: -1, dy: 0 }
const RIGHT: Direction = { dx: 1, dy: 0 }
const UP: Direction = { dx: 0, dy: -1 }
const DOWN: Direction = { dx: 0, dy: 1 }

const pin = (number: string, x: number, y: number, direction: Direction): PinDefinition => ({ number, x, y, ...direction })
const line = (...points: [number, number][]): SymbolGraphic => ({ type: 'line', points })

/** Filled arrow head with its tip at `tip`, pointing along (dx, dy). */
function arrowHead(tip: Point, dx: number, dy: number, size = 1): SymbolGraphic {
  const length = Math.hypot(dx, dy)
  const ux = dx / length
  const uy = dy / length
  const back = { x: tip.x - ux * size, y: tip.y - uy * size }
  const half = size * 0.4
  const round = (v: number) => Math.round(v * 1000) / 1000
  return {
    type: 'polygon',
    fill: 'solid',
    points: [
      [tip.x, tip.y],
      [round(back.x - uy * half), round(back.y + ux * half)],
      [round(back.x + uy * half), round(back.y - ux * half)],
    ],
  }
}

/** Pin numbers of a two- or three-pin part, in its own order. */
type Numbers = string[]

function resistor([a, b]: Numbers): SymbolDefinition {
  return {
    pins: [pin(a, -5.08, 0, LEFT), pin(b, 5.08, 0, RIGHT)],
    graphics: [line([-5.08, 0], [-2.54, 0]), line([2.54, 0], [5.08, 0]), { type: 'rect', x: -2.54, y: -0.9, w: 5.08, h: 1.8, fill: 'body' }],
    label: { x: -2.54, y: -4.2 },
  }
}

/** Ends on the first and last pin, the wiper on the middle one. */
function trimmer([a, wiper, b]: Numbers): SymbolDefinition {
  const base = resistor([a, b])
  return {
    pins: [base.pins[0], pin(wiper, 0, 5.08, DOWN), base.pins[1]],
    graphics: [...base.graphics, line([0, 5.08], [0, 1.9]), arrowHead({ x: 0, y: 0.9 }, 0, -1)],
    label: base.label,
  }
}

function capacitor([a, b]: Numbers, polarized: boolean): SymbolDefinition {
  return {
    pins: [pin(a, -2.54, 0, LEFT), pin(b, 2.54, 0, RIGHT)],
    graphics: [
      line([-2.54, 0], [-0.6, 0]),
      line([0.6, 0], [2.54, 0]),
      { type: 'rect', x: -0.95, y: -1.9, w: 0.5, h: 3.8, fill: polarized ? 'open' : 'solid' },
      { type: 'rect', x: 0.45, y: -1.9, w: 0.5, h: 3.8, fill: 'solid' },
      ...(polarized ? [{ type: 'text', x: -1.9, y: -1.1, text: '+', anchor: 'middle', style: 'mark' } as const] : []),
    ],
    label: { x: -2.54, y: -5.2 },
  }
}

/** Cathode (first pin) on the right, so current flows left to right. */
function diode([cathode, anode]: Numbers, led: boolean): SymbolDefinition {
  const lightArrows: SymbolGraphic[] = [
    line([-0.2, -1.5], [0.9, -2.6]),
    arrowHead({ x: 1.3, y: -3 }, 1, -1, 0.7),
    line([0.8, -1.5], [1.9, -2.6]),
    arrowHead({ x: 2.3, y: -3 }, 1, -1, 0.7),
  ]
  return {
    pins: [pin(cathode, 5.08, 0, RIGHT), pin(anode, -5.08, 0, LEFT)],
    graphics: [
      line([-5.08, 0], [-1.27, 0]),
      line([1.27, 0], [5.08, 0]),
      { type: 'polygon', points: [[-1.27, -1.27], [-1.27, 1.27], [1.27, 0]], fill: 'solid' },
      { type: 'rect', x: 1.1, y: -1.27, w: 0.35, h: 2.54, fill: 'solid' },
      ...(led ? lightArrows : []),
    ],
    label: { x: -2.54, y: led ? -5.6 : -4.2 },
  }
}

export type TransistorPin = 'B' | 'C' | 'E'

/** The emitter goes to the more positive side: down for NPN, up for PNP; its arrow points out for NPN, in for PNP. */
function transistor(numbers: Numbers, roles: TransistorPin[], pnp: boolean): SymbolDefinition {
  const side = pnp ? -1 : 1
  const at: Record<TransistorPin, PinDefinition> = {
    B: pin('', -5.08, 0, LEFT),
    C: pin('', 2.54, -5.08 * side, pnp ? DOWN : UP),
    E: pin('', 2.54, 5.08 * side, pnp ? UP : DOWN),
  }
  return {
    pins: roles.map((role, k) => ({ ...at[role], number: numbers[k] })),
    graphics: [
      { type: 'circle', x: 0.64, y: 0, r: 3.4, fill: 'none' },
      line([-5.08, 0], [-1.27, 0]),
      { type: 'rect', x: -1.52, y: -2.03, w: 0.5, h: 4.06, fill: 'solid' },
      line([-1.27, -0.76 * side], [2.54, -2.54 * side], [2.54, -5.08 * side]),
      line([-1.27, 0.76 * side], [2.54, 2.54 * side], [2.54, 5.08 * side]),
      pnp ? arrowHead({ x: -0.6, y: -1.1 }, -1, 0.47) : arrowHead({ x: 2.0, y: 2.29 }, 1, 0.47),
    ],
    label: { x: 4.6, y: -1.4 },
  }
}

/** A box with pins on the left and right: ICs, connectors and anything not recognised. */
function box(numbers: Numbers): SymbolDefinition {
  const leftCount = Math.ceil(numbers.length / 2)
  const rows = Math.max(leftCount, 1)
  // Whole grid steps from the origin, so an even number of rows sits half a step off-centre.
  const pinY = (row: number) => (row - Math.floor((rows - 1) / 2)) * 2.54
  const top = pinY(0) - 2.54
  const pins = numbers.map((number, k) =>
    k < leftCount ? pin(number, -7.62, pinY(k), LEFT) : pin(number, 7.62, pinY(k - leftCount), RIGHT),
  )
  return {
    pins,
    graphics: [
      { type: 'rect', x: -5.08, y: top, w: 10.16, h: (rows + 1) * 2.54, fill: 'box' },
      ...pins.flatMap((p): SymbolGraphic[] => [
        line([p.x, p.y], [p.x - p.dx * 2.54, p.y]),
        { type: 'text', x: p.x - p.dx * 3.1, y: p.y + 0.45, text: p.number, anchor: p.dx < 0 ? 'start' : 'end', style: 'pin-number' },
      ]),
    ],
    label: { x: -5.08, y: top - 3.2 },
  }
}

/**
 * Electrolytics come in a round can: EasyEDA gives a body diameter ("CAP-TH_BD8.0-..."), KiCad
 * names them "CP_..." or "...Elec...". Box footprints with length and width are film or ceramic.
 */
const isElectrolytic = (footprint: string) => /(^|[-_])BD\d|^CP_|ELEC|POL/i.test(footprint)

const isPnp = (value: string) => /BC55[6-9]|BC32[78]|BC640|BD1(3[02468]|40)|2N3906|2N2907|TIP(30|32|42)|2SA/i.test(value)

/**
 * Typical pin order per package: TO-92 as the common BC5xx (C B E), TO-126 as BD13x (E C B),
 * anything else as 2N390x (E B C). Only a starting point: the project's definition can say otherwise.
 */
function transistorRoles(component: NetComponent): TransistorPin[] {
  const shape = generatedGeometry(component).shape
  if (shape === 'to92') return ['C', 'B', 'E']
  if (shape === 'to126') return ['E', 'C', 'B']
  return ['E', 'B', 'C']
}

export interface SymbolTemplate {
  /** Short, readable id shared by every part that fits the same template, e.g. "resistor" or "pnp-ecb". */
  kind: string
  name: string
  pinNames?: string[]
  symbol: SymbolDefinition
}

/** The built-in symbol that fits a part best, guessed from its reference, pin count, value and footprint. */
export function symbolTemplate(component: NetComponent): SymbolTemplate {
  const prefix = component.ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? ''
  const numbers = component.pins.map((p) => p.number)
  const geometry = generatedGeometry(component)
  if (numbers.length === 3 && (geometry.shape === 'trimmer' || /^(RV|VR|P|POT)$/.test(prefix))) {
    return { kind: 'trimmer', name: 'Trimmer', pinNames: ['', 'W', ''], symbol: trimmer(numbers) }
  }
  if (numbers.length === 3 && prefix === 'Q') {
    const roles = transistorRoles(component)
    const pnp = isPnp(component.value)
    const type = pnp ? 'PNP' : 'NPN'
    return {
      kind: `${type.toLowerCase()}-${roles.join('').toLowerCase()}`,
      name: `${type} transistor (${roles.join(' ')})`,
      pinNames: roles,
      symbol: transistor(numbers, roles, pnp),
    }
  }
  if (numbers.length === 2) {
    // RL: a load resistor.
    if (prefix === 'R' || prefix === 'RL') return { kind: 'resistor', name: 'Resistor', symbol: resistor(numbers) }
    if (prefix === 'C' && isElectrolytic(component.footprint)) {
      return { kind: 'electrolytic', name: 'Electrolytic capacitor', pinNames: ['+', '-'], symbol: capacitor(numbers, true) }
    }
    if (prefix === 'C') return { kind: 'capacitor', name: 'Capacitor', symbol: capacitor(numbers, false) }
    if (geometry.led || prefix === 'LED') return { kind: 'led', name: 'LED', pinNames: ['K', 'A'], symbol: diode(numbers, true) }
    if (prefix === 'D') return { kind: 'diode', name: 'Diode', pinNames: ['K', 'A'], symbol: diode(numbers, false) }
  }
  return { kind: `box-${numbers.length}`, name: `Generic ${numbers.length}-pin part`, symbol: box(numbers) }
}
