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
