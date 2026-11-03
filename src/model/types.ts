// All dimensions are in millimeters.

export type Shape = 'axial' | 'radial' | 'smd' | 'to92' | 'to126' | 'trimmer' | 'dip' | 'row'

/**
 * Simple symbolic geometry in local coordinates (component center at 0,0, before rotation).
 * Not a footprint: each lead leaves the body at a fixed anchor and runs to its copper island.
 */
export interface Geometry {
  shape: Shape
  body: Rect
  anchors: Point[]
  /** Unit vectors pointing away from the body; used for leads that have no island to go to. */
  directions: Point[]
  /** How far the unbent leads stick out beyond the anchors. */
  leadLength: number
  maxLeadLength: number
  /** Drawn in its own color: an LED has the same round body as a capacitor can. */
  led: boolean
  /** Drawn with a band at pin 1: a diode's cathode. */
  band: boolean
}

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
  /** Key into the project's `definitions`. Missing for a new part until withDefinitions picks one. */
  definition?: string
}

/**
 * A part as `buildNetlist` makes it: the footprint chosen in the editor applied, and the footprint
 * geometry and schematic symbol taken from its definition. Never stored. Drawing and checks
 * take built parts, so they cannot be handed a part without its definition applied.
 */
export interface BuiltComponent extends NetComponent {
  geometry: Geometry
  symbol: SymbolDefinition
}

// ---------- Component definitions ----------
// A definition says what a kind of part is: its pins, schematic symbol and footprints. Built-in
// templates are copied into the project on first use; from then on the project's copy is the
// truth, so a project keeps working when the templates change, and an agent can add its own.

/** Where a pin ends, with the direction a wire or lead leaves it. */
export interface PinEnd extends Point {
  dx: number
  dy: number
}

/** A pin of a symbol or footprint, around the definition's origin. */
export interface PinDefinition extends PinEnd {
  number: string
}

/**
 * Fills: solid = drawing colour, body = resistor colour, power = red body of a high-power part,
 * open = background, box = IC body, none = outline only.
 */
export type SymbolGraphic =
  | { type: 'line'; points: [number, number][] }
  | { type: 'polygon'; points: [number, number][]; fill: 'solid' | 'none' }
  | { type: 'rect'; x: number; y: number; w: number; h: number; fill: 'solid' | 'body' | 'power' | 'open' | 'box' | 'none' }
  | { type: 'circle'; x: number; y: number; r: number; fill: 'solid' | 'none' }
  | { type: 'text'; x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end'; style: 'pin-number' | 'mark' }

/** Symbol in mm around its origin, y down; pin ends on the 2.54 mm grid. */
export interface SymbolDefinition {
  pins: PinDefinition[]
  graphics: SymbolGraphic[]
  /** Top-left of the reference and value text. */
  label: Point
}

/** Footprint in mm around its center, before rotation. `shape` picks how the body is drawn on the PCB. */
export interface FootprintDefinition {
  shape: 'axial' | 'radial' | 'smd' | 'to92' | 'to126' | 'trimmer' | 'dip' | 'row'
  body: Rect
  /** Where each lead leaves the body, and the direction it points. */
  pins: PinDefinition[]
  /** How far unbent leads stick out beyond the body. */
  leadLength: number
  /** Leads longer than this are flagged. */
  maxLeadLength: number
  /** Drawn in LED colour. */
  led?: boolean
  /** A band on the body at pin 1, the way a diode marks its cathode. */
  band?: boolean
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

export interface BuiltNetlist extends Netlist {
  components: BuiltComponent[]
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

export interface Layout {
  islands: Island[]
  placements: Placement[]
}

/** How the copper is made (buildStyles.ts BUILD_STYLES): islands cut from a board, or pads glued on a ground plane. */
export type BuildStyleId = 'knife' | 'manhattan'

export interface Settings {
  snap: number
  isolation: number
  buildStyle: BuildStyleId
}

/** Where a component's symbol sits on the schematic, in mm. Rotation is a multiple of 90 degrees. */
export interface SchematicPlacement {
  ref: string
  x: number
  y: number
  rotation: number
  /** Mirrored left to right before rotating. Missing means not mirrored. */
  mirrored?: boolean
  /**
   * Where the reference and value text start (top-left), relative to x/y and not rotated: the text
   * always stays upright. Missing means the symbol's own spot, turned with the symbol.
   */
  textOffset?: Point
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
  /**
   * How it is drawn: as its name, or as a ground, power or terminal (connection point) symbol,
   * which then stays that symbol whatever it is renamed to.
   */
  symbol: LabelSymbol
  /** Degrees clockwise, a multiple of 90. At 0 ground points down and power up. */
  rotation?: number
}

export type LabelSymbol = 'net' | 'ground' | 'power' | 'terminal'

/** The schematic's wires and labels decide which pins share a net; the PCB takes them over on "Update PCB". */
export interface Schematic {
  /** One per component, in netlist order. */
  placements: SchematicPlacement[]
  wires: Wire[]
  labels: NetLabel[]
}

/** A project is called by its file's name (or its tab's, before it is saved); it holds no name itself. */
export interface Project {
  /** Given once at creation and kept through renames, saves and reopening, so a project can be traced. */
  guid: string
  netlist: Netlist
  layout: Layout
  schematic: Schematic
  /** The project's own component definitions, keyed by the id in each component's `definition`. */
  definitions?: Record<string, ComponentDefinition>
  settings: Settings
}

/** A project with its netlist built (see BuiltComponent), as checks and agent edits read it. */
export interface BuiltProject extends Project {
  netlist: BuiltNetlist
}

/**
 * Schematic wiring in a selection: wires and labels by their index in the schematic, and wire ends
 * (corners, junctions) by position. Only the schematic view uses it; the PCB ignores it.
 */
export interface WiringSelection {
  wires: number[]
  labels: number[]
  points: Point[]
}

export type Selection =
  | { kind: 'island'; net: string; rectIndex: number }
  | { kind: 'part'; ref: string }
  /** Two or more items, or any wiring; a single part or island always uses one of the kinds above. */
  | { kind: 'multi'; refs: string[]; nets: string[]; wiring?: WiringSelection }
  | null
