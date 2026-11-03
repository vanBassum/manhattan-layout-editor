// Built-in footprint templates: a part's footprint read from its footprint name, and from its
// reference and pin count when the name says too little. What else a footprint name or reference
// says about a part (LED, electrolytic, its kind of package) is read here too, so the PCB and the
// schematic symbols agree.

import type { FootprintDefinition, NetComponent, PinEnd, Rect, Shape } from './types'

const PITCH = 2.54
/** Spacing of TO-92 legs where they leave the package (datasheet dimension G). */
const TO92_LEG_PITCH = 1.27

/** Roughly how far a lead of each package can reach, in mm. Longer leads are flagged. */
const MAX_LEAD_LENGTH: Record<Shape, number> = {
  axial: 25,
  radial: 15,
  smd: 0.5,
  to92: 14,
  to126: 15,
  trimmer: 4,
  dip: 3.5,
  row: 5,
}

/** Imperial SMD chip size code to length x width in mm. */
const CHIP_SIZES: Record<string, [number, number]> = {
  '0201': [0.6, 0.3],
  '0402': [1.0, 0.5],
  '0603': [1.6, 0.8],
  '0805': [2.0, 1.25],
  '1206': [3.2, 1.6],
  '1210': [3.2, 2.5],
  '2512': [6.3, 3.2],
}

const CHIP_CODES = Object.keys(CHIP_SIZES).join('|')

/** The letters a reference starts with, in capitals: "R" for "R12", "LED" for "led3". */
export const refPrefix = (ref: string) => ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? ''

export const isLed = (component: NetComponent) =>
  /LED/i.test(component.footprint) || /^LED/i.test(component.ref) || /^LED\b/i.test(component.value)

/**
 * Electrolytics come in a round can: EasyEDA gives a body diameter ("CAP-TH_BD8.0-..."), KiCad
 * names them "CP_..." or "...Elec...". Box footprints with length and width are film or ceramic.
 */
export const isElectrolytic = (footprint: string) => /(^|[-_])BD\d|CP_|ELEC|POL/i.test(footprint)

export function shapeOf(component: NetComponent): Shape {
  const footprint = component.footprint.toUpperCase()
  if (/TO-?126|TO-?220/.test(footprint)) return 'to126'
  if (/TO-?92/.test(footprint)) return 'to92'
  if (/RES-ADJ|TRIM|POT/.test(footprint)) return 'trimmer'
  if (/DIP/.test(footprint)) return 'dip'
  if (/AXIAL|DO-?35|DO-?41|RES-TH/.test(footprint)) return 'axial'
  if (/SMD|SOT|SOD|SOIC|SOP|QFN/.test(footprint) || new RegExp(`^[A-Z]*(${CHIP_CODES})`).test(footprint)) return 'smd'
  if (/RADIAL|CAP-TH|CP_|ELEC/.test(footprint)) return 'radial'

  // No recognizable footprint: guess from reference prefix and pin count.
  const pinCount = component.pins.length
  const prefix = refPrefix(component.ref)
  if (pinCount === 2) return prefix === 'C' ? 'radial' : 'axial'
  if (pinCount === 3 && prefix === 'Q') return 'to92'
  if (pinCount >= 4 && pinCount % 2 === 0) return 'dip'
  return 'row'
}

/** EasyEDA footprint names carry dimensions like "L7.6-W2.7-P2.30" or "BD3.0". */
function footprintDimension(footprint: string, key: string): number | undefined {
  const match = footprint.toUpperCase().match(new RegExp(`(?:^|[-_])${key}(\\d+(?:\\.\\d+)?)`))
  return match ? Number(match[1]) : undefined
}

function chipSize(footprint: string): [number, number] | undefined {
  const code = footprint.match(new RegExp(CHIP_CODES))?.[0]
  return code ? CHIP_SIZES[code] : undefined
}

/** The body, and where each lead leaves it with the direction it points, in pin order. */
interface Leads {
  body: Rect
  ends: PinEnd[]
}

/** Leads in a row along the bottom edge of the body, pointing down. */
function rowLeads(pinCount: number, pitch: number, width: number, height: number): Leads {
  const span = (pinCount - 1) * pitch
  return {
    body: { x: -width / 2, y: -height, w: width, h: height },
    ends: Array.from({ length: pinCount }, (_, k) => ({ x: -span / 2 + k * pitch, y: 0, dx: 0, dy: 1 })),
  }
}

/** Two leads leaving the left and right ends of the body. */
function endLeads(length: number, width: number): Leads {
  return {
    body: { x: -length / 2, y: -width / 2, w: length, h: width },
    ends: [
      { x: -length / 2, y: 0, dx: -1, dy: 0 },
      { x: length / 2, y: 0, dx: 1, dy: 0 },
    ],
  }
}

function leadsFor(shape: Shape, component: NetComponent): Leads {
  const footprint = component.footprint
  const pinCount = component.pins.length
  const length = footprintDimension(footprint, 'L')
  const width = footprintDimension(footprint, 'W')
  const pitch = footprintDimension(footprint, 'P') ?? PITCH

  switch (shape) {
    case 'axial':
      if (pinCount === 2) return endLeads(length ?? 6.3, width ?? footprintDimension(footprint, 'BD') ?? 2.3)
      break
    case 'radial': {
      // Seen from above; the leads come out underneath. Box capacitors give a length and width,
      // cans a body diameter ("BD" in EasyEDA, "D" in KiCad). A small EasyEDA "D" is the lead diameter.
      if (pinCount !== 2) break
      const d = footprintDimension(footprint, 'D')
      const canDiameter = footprintDimension(footprint, 'BD') ?? (d !== undefined && d >= 2 ? d : isElectrolytic(footprint) ? 5 : undefined)
      // Nothing in the name says it is a can: a small block, like a ceramic or film capacitor.
      const [bodyLength, bodyWidth] = length && width ? [length, width] : canDiameter ? [canDiameter, canDiameter] : [5, 2.5]
      const leadSpacing = footprintDimension(footprint, 'P') ?? bodyLength / 2
      return {
        body: { x: -bodyLength / 2, y: -bodyWidth / 2, w: bodyLength, h: bodyWidth },
        ends: [
          { x: -leadSpacing / 2, y: 0, dx: -1, dy: 0 },
          { x: leadSpacing / 2, y: 0, dx: 1, dy: 0 },
        ],
      }
    }
    case 'smd': {
      const [chipLength, chipWidth] = chipSize(footprint) ?? [length ?? 2, width ?? 1.25]
      if (pinCount === 2) return endLeads(chipLength, chipWidth)
      return rowLeads(pinCount, footprintDimension(footprint, 'P') ?? 0.95, chipLength, chipWidth)
    }
    case 'to92': {
      // The legs leave the bottom of the package in a row through the centre of its round part,
      // about 0.4 of the depth behind the flat face (as in KiCad's TO-92_Inline). They leave it
      // 1.27 mm apart; a footprint's larger pitch is where formed legs land, and here every leg
      // is bent to its own island anyway.
      const leads = rowLeads(pinCount, TO92_LEG_PITCH, length ?? 4.9, width ?? 3.7)
      return { ...leads, body: { ...leads.body, y: -0.6 * leads.body.h } }
    }
    case 'to126':
      return rowLeads(pinCount, pitch, length ?? 7.6, width ?? 2.7)
    case 'trimmer': {
      const leads = rowLeads(pinCount, pitch, length ?? 9.5, width ?? 9.5)
      // A standing trimmer (3296W) has its pins underneath, along the middle of the body.
      if (length === undefined || length === width) return leads
      return { ...leads, body: { ...leads.body, y: -leads.body.h / 2 } }
    }
    case 'dip': {
      // Numbered counter-clockwise from top left, like a DIP seen from above.
      const perSide = pinCount / 2
      const top = (-(perSide - 1) * PITCH) / 2
      const left = Array.from({ length: perSide }, (_, k) => ({ x: -2.8, y: top + k * PITCH, dx: -1, dy: 0 }))
      const right = Array.from({ length: perSide }, (_, k) => ({ x: 2.8, y: top + (perSide - 1 - k) * PITCH, dx: 1, dy: 0 }))
      return {
        body: { x: -2.8, y: top - 1.2, w: 5.6, h: (perSide - 1) * PITCH + 2.4 },
        ends: [...left, ...right],
      }
    }
  }
  return rowLeads(pinCount, PITCH, (pinCount - 1) * PITCH + 2.4, 2.8)
}

/**
 * Unbent lead length beyond the body. SMD parts have none and DIP legs are short. Axial parts are
 * bent to their hole spacing: "R_AXIAL-0.4" gives it in inches (0.4" = 10.16 mm), "P13.00" in mm.
 */
function defaultLeadLength(shape: Shape, footprint: string, body: Rect): number {
  if (shape === 'smd') return 0
  if (shape === 'dip') return 1
  if (shape === 'axial') {
    const inches = footprint.match(/AXIAL-?(\d+(?:\.\d+)?)/i)?.[1]
    const holeSpacing = inches ? Number(inches) * 25.4 : footprintDimension(footprint, 'P')
    if (holeSpacing) return Math.max(1, (holeSpacing - body.w) / 2)
  }
  return PITCH
}

/**
 * The built-in footprint template for the part's pins, read from the footprint name (and reference
 * and pin count when it says too little).
 */
export function generatedFootprint(component: NetComponent): FootprintDefinition {
  const shape = shapeOf(component)
  const { body, ends } = leadsFor(shape, component)
  // Diode templates number the cathode 1 (see schematicSymbols.ts); an LED shows it by its colour.
  const band = /^D\d/i.test(component.ref) && !isLed(component)
  return {
    shape,
    body,
    pins: component.pins.map((pin, k) => ({ number: pin.number, ...ends[k] })),
    leadLength: defaultLeadLength(shape, component.footprint, body),
    maxLeadLength: MAX_LEAD_LENGTH[shape],
    ...(isLed(component) ? { led: true } : {}),
    ...(band ? { band: true } : {}),
  }
}
