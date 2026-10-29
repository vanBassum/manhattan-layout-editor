// Footprints offered by the "Change footprint" dialog. Each id is a footprint name that the
// geometry code in layout.ts understands (shape and size are parsed from the name).

export type FootprintCategory = 'Resistors' | 'Capacitors' | 'Transistors' | 'Diodes' | 'Other'

export interface LibraryFootprint {
  id: string
  label: string
  category: FootprintCategory
  pins: number
  description: string
}

export const FOOTPRINT_LIBRARY: LibraryFootprint[] = [
  { id: 'R1206', label: '1206 SMD resistor', category: 'Resistors', pins: 2, description: '3.2 × 1.6 mm chip, bridges the gap' },
  { id: 'R0805', label: '0805 SMD resistor', category: 'Resistors', pins: 2, description: '2.0 × 1.25 mm chip, bridges the gap' },
  { id: 'R0603', label: '0603 SMD resistor', category: 'Resistors', pins: 2, description: '1.6 × 0.8 mm chip, bridges the gap' },
  { id: 'R_AXIAL-0.3', label: 'Axial 1/4 W, 7.62 mm', category: 'Resistors', pins: 2, description: '6.3 × 2.3 mm body, holes 0.3" apart' },
  { id: 'R_AXIAL-0.4', label: 'Axial 1/4 W, 10.16 mm', category: 'Resistors', pins: 2, description: '6.3 × 2.3 mm body, holes 0.4" apart' },
  { id: 'C1206', label: '1206 SMD capacitor', category: 'Capacitors', pins: 2, description: '3.2 × 1.6 mm chip, bridges the gap' },
  { id: 'C0805', label: '0805 SMD capacitor', category: 'Capacitors', pins: 2, description: '2.0 × 1.25 mm chip, bridges the gap' },
  { id: 'CAP-TH_L5.5-W2.5-P5.00', label: 'Box capacitor, 5 mm pitch', category: 'Capacitors', pins: 2, description: '5.5 × 2.5 mm box, leads 5.0 mm apart' },
  { id: 'CAP-TH_BD5.0-P2.00', label: 'Radial can Ø5 mm', category: 'Capacitors', pins: 2, description: 'Ø5.0 mm can, leads 2.0 mm apart' },
  { id: 'CAP-TH_BD6.3-P2.50', label: 'Radial can Ø6.3 mm', category: 'Capacitors', pins: 2, description: 'Ø6.3 mm can, leads 2.5 mm apart' },
  { id: 'TO-92-3_L4.9-W3.7-P2.54-L', label: 'TO-92', category: 'Transistors', pins: 3, description: '4.9 × 3.7 mm, three leads 2.54 mm apart' },
  { id: 'TO-126-3_L7.6-W2.7-P2.30-L', label: 'TO-126', category: 'Transistors', pins: 3, description: '7.6 × 2.7 mm, three leads 2.3 mm apart' },
  { id: 'SOT-23-3_L2.9-W1.3', label: 'SOT-23', category: 'Transistors', pins: 3, description: '2.9 × 1.3 mm SMD, three pads 0.95 mm apart' },
  { id: 'DO-35_BD1.9-L3.8-P7.62', label: 'DO-35 (1N4148)', category: 'Diodes', pins: 2, description: '3.8 × 1.9 mm glass body, holes 7.62 mm apart' },
  { id: 'DO-41_BD2.7-L5.2-P10.16', label: 'DO-41 (1N4007)', category: 'Diodes', pins: 2, description: '5.2 × 2.7 mm body, holes 10.16 mm apart' },
  { id: 'SOD-123_L2.7-W1.6', label: 'SOD-123 SMD diode', category: 'Diodes', pins: 2, description: '2.7 × 1.6 mm, bridges the gap' },
]

/** Pin count of a library footprint; undefined for names outside the library, which cannot be checked. */
export function footprintPinCount(footprint: string): number | undefined {
  return FOOTPRINT_LIBRARY.find((f) => f.id === footprint)?.pins
}
