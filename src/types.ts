// All dimensions are in millimeters.

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

export interface Layout {
  islands: Island[]
  placements: Placement[]
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

export interface Project {
  /** Given once at creation and kept through renames, saves and reopening, so a project can be traced. */
  guid: string
  name: string
  netlist: Netlist
  layout: Layout
  settings: Settings
}

export type Selection =
  | { kind: 'island'; net: string; rectIndex: number }
  | { kind: 'part'; ref: string }
  /** Two or more items; a single item always uses one of the kinds above. */
  | { kind: 'multi'; refs: string[]; nets: string[] }
  | null
