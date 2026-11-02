// All dimensions are in millimeters.

import type { Geometry } from './layout'

export interface Pin {
  number: string
  net: string
}

export interface NetComponent {
  ref: string
  value: string
  /** Package name as given by the netlist, e.g. "TO-126-3_L7.6-W2.7-P2.30-L". May be empty. */
  footprint: string
  pins: Pin[]
  /** Key into the project's `definitions`. Missing until the project is first saved: then a built-in template is picked. */
  definition?: string
  /**
   * Resolved from the definition by `buildNetlist`, only on a built netlist and never stored:
   * the footprint geometry for the chosen footprint and the schematic symbol.
   */
  geometry?: Geometry
  symbol?: SymbolDefinition
}

// ---------- Component definitions ----------
// A definition says what a kind of part is: its pins, schematic symbol and footprints. Built-in
// templates are copied into the project on first use; from then on the project's copy is the
// truth, so a project keeps working when the templates change, and an agent can add its own.

/** A pin end on the symbol, with the direction a wire leaves it. */
export interface SymbolPinDefinition extends Point {
  number: string
  dx: number
  dy: number
}

/** Fills: solid = drawing colour, body = resistor colour, open = background, box = IC body, none = outline only. */
export type SymbolGraphic =
  | { type: 'line'; points: [number, number][] }
  | { type: 'polygon'; points: [number, number][]; fill: 'solid' | 'none' }
  | { type: 'rect'; x: number; y: number; w: number; h: number; fill: 'solid' | 'body' | 'open' | 'box' | 'none' }
  | { type: 'circle'; x: number; y: number; r: number; fill: 'solid' | 'none' }
  | { type: 'text'; x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end'; style: 'pin-number' | 'mark' }

/** Symbol in mm around its origin, y down; pin ends on the 2.54 mm grid. */
export interface SymbolDefinition {
  pins: SymbolPinDefinition[]
  graphics: SymbolGraphic[]
  /** Top-left of the reference and value text. */
  label: Point
}

/** A footprint pin: where the lead leaves the body, and the direction it points. */
export interface FootprintPinDefinition extends Point {
  number: string
  dx: number
  dy: number
}

/** Footprint in mm around its center, before rotation. `shape` picks how the body is drawn on the PCB. */
export interface FootprintDefinition {
  shape: 'axial' | 'radial' | 'smd' | 'to92' | 'to126' | 'trimmer' | 'dip' | 'row'
  body: Rect
  pins: FootprintPinDefinition[]
  /** How far unbent leads stick out beyond the body. */
  leadLength: number
  /** Leads longer than this are flagged. */
  maxLeadLength: number
  /** Drawn in LED colour. */
  led?: boolean
}

export interface ComponentDefinition {
  name: string
  pins: { number: string; name?: string }[]
  symbol: SymbolDefinition
  /** Keyed by footprint name, e.g. "R1206" or "TO-126-3_L7.6-W2.7-P2.30-L"; a part picks one. */
  footprints: Record<string, FootprintDefinition>
}

export interface Netlist {
  components: NetComponent[]
  nets: string[]
}

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A copper island is the union of one or more rectangles. */
export interface Island {
  net: string
  rects: Rect[]
  /** A copper-clad ground plane that other islands (glued pads) can sit on top of. */
  plane?: boolean
}

export interface Placement {
  ref: string
  x: number
  y: number
  /** Degrees clockwise; any angle. */
  rotation: number
  /**
   * Bent lead ends, keyed by pin number, relative to the component center before rotation
   * (so they follow when the component moves or rotates). Pins without an entry use their default.
   */
  leads?: Record<string, Point>
  /** Footprint chosen in the editor; replaces the netlist's footprint for this part. */
  footprint?: string
}

/** A straight cut along x or y (x1 = x2 or y1 = y2) in a knife cut-line layout. */
export interface CutLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Knife with cut lines: a solid board split by cuts. Which net each piece belongs to follows from the leads. */
export interface CutBoard {
  board: Rect
  cuts: CutLine[]
}

export interface Layout {
  /** Derived from `knife` when that is set; stored as edited otherwise. */
  islands: Island[]
  placements: Placement[]
  knife?: CutBoard
  /** Derived with `islands` in a cut-line layout: copper that no lead reaches. */
  freeCopper?: Rect[][]
}

export interface Settings {
  snap: number
  isolation: number
  /** Id of the optimization strategy selected in the toolbar. */
  strategy: string
  /** Free space the optimizer keeps around each component (body and leads), for soldering access. */
  clearance: number
  /** Longest lead the optimizer should bend; beyond this the penalty rises sharply. */
  maxLead: number
}

/** Where a component's symbol sits on the schematic, in mm. Rotation is a multiple of 90 degrees. */
export interface SchematicPlacement {
  ref: string
  x: number
  y: number
  rotation: number
}

/** A straight wire between two grid points. It connects where an end meets a pin, another end, or lands on a wire. */
export interface Wire {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** A net name at a point. Labels with the same name are connected, wherever they are. */
export interface NetLabel {
  x: number
  y: number
  name: string
}

export interface Schematic {
  placements: SchematicPlacement[]
  wires?: Wire[]
  /** Missing until the schematic is first edited: then every pin gets a label with its net from the imported netlist. */
  labels?: NetLabel[]
}

export interface Project {
  /** Given once at creation and kept through renames, saves and reopening, so a project can be traced. */
  guid: string
  name: string
  netlist: Netlist
  layout: Layout
  /** Missing in projects from before the schematic view, and for components not moved yet: those get a grid spot. */
  schematic?: Schematic
  /** The project's own component definitions, keyed by the id in each component's `definition`. */
  definitions?: Record<string, ComponentDefinition>
  settings: Settings
}

export type Selection =
  | { kind: 'island'; net: string; rectIndex: number }
  | { kind: 'part'; ref: string }
  /** Two or more items; a single item always uses one of the kinds above. */
  | { kind: 'multi'; refs: string[]; nets: string[] }
  | null
