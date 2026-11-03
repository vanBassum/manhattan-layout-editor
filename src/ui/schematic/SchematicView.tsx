import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { boundsOf, inflate, rectBetween, snapToGrid } from '../../geometry'
import {
  alongDragAxis,
  CELL_HEIGHT,
  CELL_WIDTH,
  draggedSchematic,
  grabAt,
  isConnection,
  labelDirection,
  labelSymbol,
  looseWireEnds,
  marqueeSelection,
  pinKeysOf,
  placedParts,
  pointKey,
  polylineWires,
  route,
  SCHEMATIC_GRID,
  snapPoint,
  withTidyWires,
  type FullSchematic,
  type SchematicNets,
} from '../../schematic'
import {
  addToSelection,
  isSchematicItemSelected,
  isToggleClick,
  schematicItemSelection,
  selectedNets,
  selectedRefs,
  selectedWiring,
  selectionOf,
  toggleSchematicItem,
  type SchematicItem,
} from '../../selection'
import type { BuiltComponent, BuiltNetlist, Point, Rect, SchematicPlacement, Selection } from '../../types'
import { layerClasses, layerOpacities, type SchematicLayers } from '../layers'
import { gridPitch, gridPitches, useViewport, ViewportGrid, type View } from '../viewport'
import { LabelMark, SchematicPart, textOffsetOf } from './SchematicDrawing'

/**
 * Select: drag parts; drag from a pin end to draw a wire; drag a wire end to move it, or a wire
 * sideways to shift it. Wire: drag for one wire, or click corner by corner. Label: click to name a point.
 */
export type SchematicTool = 'select' | 'wire' | 'label'

/** A press that moves less than this (screen pixels) is a click, not a drag. */
const CLICK_TOLERANCE_PX = 3
/** How close (screen pixels) the pointer must be to grab a pin end or wire end. */
const GRAB_RADIUS_PX = 8
/**
 * Never further than this (mm): zoomed out, 8 pixels would cover most of a small symbol, and a
 * press meant to move the part would start a wire instead.
 */
const MAX_GRAB_RADIUS_MM = 1

/**
 * The wire being drawn, whatever started it: the corners placed so far, where the pointer is, and
 * which way the next leg bends first (null until the pointer first moves, which decides it).
 */
interface WireDraft {
  points: Point[]
  cursor: Point
  horizontalFirst: boolean | null
}

const draftPath = (draft: WireDraft) => {
  const last = draft.points[draft.points.length - 1]
  return [...draft.points, ...route(last, draft.cursor, draft.horizontalFirst ?? true).slice(1)]
}

type Drag =
  | { kind: 'pan'; startX: number; startY: number; view: View }
  | { kind: 'marquee'; start: Point; startX: number; startY: number; additive: boolean }
  /**
   * The pressed item, or the whole selection when it is in it (`moving`). Each step is applied to
   * `base`, the schematic at the start, shifted by `delta`. `keepConnections`: drag (the wiring
   * around it stretches along) or, with Shift, move (only the selection moves). A press that ends
   * without moving selects `pressed` alone, or with `toggle` set, toggles it in the selection.
   */
  | {
      kind: 'selection'
      pressed: SchematicItem
      toggle: boolean
      keepConnections: boolean
      start: Point
      moving: Selection
      base: FullSchematic
      delta: Point
      moved: boolean
    }
  /** A press that starts or continues a wire draft: dragging finishes it on release, a click keeps drawing. */
  | { kind: 'draw'; startX: number; startY: number; moved: boolean }
  /** A part's reference and value text, dragged on its own; the part stays where it is. */
  | { kind: 'part-text'; ref: string; start: Point; origin: Point; moved: boolean }

type SelectionDrag = Extract<Drag, { kind: 'selection' }>
type MarqueeDrag = Extract<Drag, { kind: 'marquee' }>

/** Reference and value text moves in quarter grid steps: finer than parts, so it can be fitted between wires. */
const TEXT_STEP = SCHEMATIC_GRID / 4

interface Props {
  /** As built, with the nets the schematic gives. */
  netlist: BuiltNetlist
  schematic: FullSchematic
  nets: SchematicNets
  onChange: (next: FullSchematic) => void
  /** Called once per edit, just before its first change, so it can be undone as a whole. */
  onBeginEdit: () => void
  selection: Selection
  onSelect: (selection: Selection) => void
  tool: SchematicTool
  fitRequest: number
  layers: SchematicLayers
  /** Fine grid steps (0.1 inch, where pins sit) between two solid grid lines. */
  gridLinesPerMajor: number
}

export function SchematicView({
  netlist,
  schematic,
  nets,
  onChange,
  onBeginEdit,
  selection,
  onSelect,
  tool,
  fitRequest,
  layers,
  gridLinesPerMajor,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [draft, setDraft] = useState<WireDraft | null>(null)
  const [overPoint, setOverPoint] = useState(false)
  const [marquee, setMarquee] = useState<{ rect: Rect; crossing: boolean } | null>(null)
  const { view, setView, size, fitTo } = useViewport(svgRef)
  const highlightedRefs = new Set(selectedRefs(selection))
  const wiring = selectedWiring(selection)
  const highlightedWires = new Set(wiring.wires)
  const highlightedLabels = new Set(wiring.labels)

  const parts = placedParts(schematic.placements, netlist)
  const pinKeys = pinKeysOf(parts)
  const grabRadius = Math.min(GRAB_RADIUS_PX / view.scale, MAX_GRAB_RADIUS_MM)

  useEffect(() => {
    const cells = schematic.placements.map((p) => ({ x: p.x - CELL_WIDTH / 2, y: p.y - CELL_HEIGHT / 2, w: CELL_WIDTH, h: CELL_HEIGHT }))
    const bounds = boundsOf(cells)
    if (bounds) fitTo(inflate(bounds, 5))
    // Only refit when explicitly requested, not on every edit.
  }, [fitRequest])

  // A draft belongs to the tool it was started in.
  useEffect(() => setDraft(null), [tool])

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - view.ox) / view.scale, y: (e.clientY - r.top - view.oy) / view.scale }
  }

  const beginDrag = (e: ReactPointerEvent, drag: Drag) => {
    dragRef.current = drag
    svgRef.current!.setPointerCapture(e.pointerId)
  }

  // ---------- Wire drafts: every way of drawing ends up here ----------

  const startDraft = (at: Point) => setDraft({ points: [at], cursor: at, horizontalFirst: null })

  /** Adds the wires along `points` as one undo step and ends the draft. */
  const finishDraft = (points: Point[]) => {
    setDraft(null)
    const wires = polylineWires(points)
    if (wires.length === 0) return
    onBeginEdit()
    onChange({ ...schematic, wires: [...schematic.wires, ...wires] })
  }

  /** A click while drawing: route to it and place a corner there; ending on a pin or wire connects and finishes. */
  const placeCorner = (at: Point) => {
    if (!draft) return
    const path = draftPath({ ...draft, cursor: at })
    if (path.length > 1 && isConnection(at, schematic.wires, pinKeys)) finishDraft(path)
    else setDraft({ points: path, cursor: at, horizontalFirst: null })
  }

  const moveDraftCursor = (p: Point) => {
    if (!draft) return
    const cursor = snapPoint(p)
    const last = draft.points[draft.points.length - 1]
    // The first move away from the last corner decides which leg of the L comes first.
    const horizontalFirst =
      draft.horizontalFirst ?? (pointKey(cursor) === pointKey(last) ? null : Math.abs(p.x - last.x) >= Math.abs(p.y - last.y))
    setDraft({ ...draft, cursor, horizontalFirst })
  }

  // ---------- Pointer input ----------

  /** Runs before the parts' and wires' own handlers: drafts and pin/wire ends take precedence over them. */
  const onPointerDownCapture = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const p = toWorld(e)
    const press = { startX: e.clientX, startY: e.clientY, moved: false }
    if (draft) {
      e.stopPropagation()
      placeCorner(snapPoint(p))
      beginDrag(e, { kind: 'draw', ...press })
      return
    }
    if (tool === 'wire') {
      e.stopPropagation()
      startDraft(grabAt(schematic.wires, parts, p, grabRadius)?.point ?? snapPoint(p))
      beginDrag(e, { kind: 'draw', ...press })
      return
    }
    if (tool !== 'select') return
    const grab = grabAt(schematic.wires, parts, p, grabRadius)
    if (!grab) return
    // From a pin, or with Shift from a wire end: a new wire. A loose wire end, corner or junction
    // is an item of its own: pressing it selects it, dragging it takes every wire end there along.
    if (grab.onPin || e.shiftKey) {
      e.stopPropagation()
      startDraft(grab.point)
      beginDrag(e, { kind: 'draw', ...press })
    } else {
      pressItem(e, { kind: 'point', point: grab.point })
    }
  }

  const askLabelName = (current = '') => window.prompt('Net name (labels with the same name are connected)', current)?.trim()

  const onBackgroundPointerDown = (e: ReactPointerEvent) => {
    if (e.button === 0 && tool === 'label') {
      const at = snapPoint(toWorld(e))
      const name = askLabelName()
      if (!name) return
      onBeginEdit()
      // The symbol is decided once, from the name; renaming it later keeps it.
      onChange({ ...schematic, labels: [...schematic.labels, { ...at, name, symbol: labelSymbol({ ...at, name }) }] })
      return
    }
    // As on the PCB: the left button draws a selection rectangle, the middle button pans.
    if (e.button === 0 && tool === 'select') {
      beginDrag(e, { kind: 'marquee', start: toWorld(e), startX: e.clientX, startY: e.clientY, additive: isToggleClick(e) })
      return
    }
    beginDrag(e, { kind: 'pan', startX: e.clientX, startY: e.clientY, view })
  }

  /** In the label tool everything acts as background. */
  const selectToolOnly = (e: ReactPointerEvent) => e.button === 0 && tool === 'select'

  /**
   * Pressing an item of the selection drags the whole selection; otherwise the item alone is
   * selected and dragged. Shift+drag moves instead of drags, as on the PCB, where Shift+drag takes
   * the leads along. A Shift/Ctrl press that ends without dragging toggles the item instead.
   */
  const pressItem = (e: ReactPointerEvent, pressed: SchematicItem) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    const toggle = isToggleClick(e)
    const inSelection = isSchematicItemSelected(selection, pressed)
    const moving = inSelection ? selection : schematicItemSelection(pressed)
    if (!inSelection && !toggle) onSelect(moving)
    beginDrag(e, {
      kind: 'selection',
      pressed,
      toggle,
      keepConnections: !e.shiftKey,
      start: toWorld(e),
      moving,
      base: schematic,
      delta: { x: 0, y: 0 },
      moved: false,
    })
  }

  /** Pressing a part's text selects the part; dragging moves only the text. */
  const pressPartText = (e: ReactPointerEvent, component: BuiltComponent, placement: SchematicPlacement) => {
    if (!selectToolOnly(e)) return
    e.stopPropagation()
    onSelect({ kind: 'part', ref: placement.ref })
    beginDrag(e, { kind: 'part-text', ref: placement.ref, start: toWorld(e), origin: textOffsetOf(component, placement), moved: false })
  }


  /** After a drag: folded-up wires go, and the selection follows the wires and points that moved. */
  const finishMove = (drag: SelectionDrag) => {
    const moving = selectedWiring(drag.moving)
    // Where the drag kept every connection, it should leave no loose end that was not there before.
    const baseLoose = looseWireEnds(drag.base, netlist)
    const allowedLooseEnds = drag.keepConnections
      ? [...baseLoose, ...baseLoose.map((p) => ({ x: p.x + drag.delta.x, y: p.y + drag.delta.y }))]
      : undefined
    const { schematic: tidy, selectedWires, changed } = withTidyWires(schematic, netlist, moving.wires, allowedLooseEnds)
    if (changed) onChange(tidy)
    if (drag.moving !== selection) return
    const { x: dx, y: dy } = drag.delta
    const points = moving.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
    onSelect(selectionOf(selectedRefs(selection), selectedNets(selection), { ...moving, wires: selectedWires, points }))
  }

  const renameLabel = (index: number) => {
    const name = askLabelName(schematic.labels[index].name)
    if (!name) return
    onBeginEdit()
    onChange({ ...schematic, labels: schematic.labels.map((l, k) => (k === index ? { ...l, name, symbol: labelSymbol(l) } : l)) })
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const p = toWorld(e)
    const drag = dragRef.current
    moveDraftCursor(p)
    if (!drag) {
      setOverPoint(tool === 'select' && grabAt(schematic.wires, parts, p, grabRadius) !== null)
      return
    }
    if (drag.kind === 'pan') {
      setView({ ...drag.view, ox: drag.view.ox + e.clientX - drag.startX, oy: drag.view.oy + e.clientY - drag.startY })
      return
    }
    if (drag.kind === 'marquee') {
      setMarquee({ rect: rectBetween(drag.start, p), crossing: p.x < drag.start.x })
      return
    }
    if (drag.kind === 'draw') {
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) return
      drag.moved = true
      return
    }
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    if (!drag.moved) {
      if (Math.hypot(dx, dy) * view.scale <= CLICK_TOLERANCE_PX) return
      drag.moved = true
      onBeginEdit()
    }
    if (drag.kind === 'part-text') {
      const textOffset = { x: snapToGrid(drag.origin.x + dx, TEXT_STEP), y: snapToGrid(drag.origin.y + dy, TEXT_STEP) }
      onChange({ ...schematic, placements: schematic.placements.map((p) => (p.ref === drag.ref ? { ...p, textOffset } : p)) })
      return
    }
    drag.delta = snapPoint(alongDragAxis(drag, { x: dx, y: dy }))
    onChange(draggedSchematic(schematic, netlist, drag, drag.delta))
  }

  /** Dragged left to right (a window), the rectangle selects what lies inside it; right to left (crossing), whatever it touches. */
  const finishMarquee = (drag: MarqueeDrag, e: ReactPointerEvent) => {
    setMarquee(null)
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_TOLERANCE_PX) {
      if (!drag.additive) onSelect(null)
      return
    }
    const end = toWorld(e)
    const crossing = end.x < drag.start.x
    const { refs, wiring: found } = marqueeSelection(schematic, parts, rectBetween(drag.start, end), crossing)
    onSelect(drag.additive ? addToSelection(selection, refs, [], found) : selectionOf(refs, [], found))
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    dragRef.current = null
    svgRef.current!.releasePointerCapture(e.pointerId)
    if (drag?.kind === 'marquee') finishMarquee(drag, e)
    if (drag?.kind === 'selection') {
      if (drag.moved) finishMove(drag)
      else onSelect(drag.toggle ? toggleSchematicItem(selection, drag.pressed) : schematicItemSelection(drag.pressed))
    }
    if (drag?.kind !== 'draw' || !draft) return
    // A drag draws one wire; a click in the wire tool goes on corner by corner. In the select
    // tool a click on a pin end is not meant as drawing.
    if (drag.moved) finishDraft(draftPath(draft))
    else if (tool === 'select') setDraft(null)
  }

  // ---------- Keys ----------

  /** Deletes the selected wires and labels; parts come from the netlist and stay. */
  const removeSelectedWiring = () => {
    if (wiring.wires.length === 0 && wiring.labels.length === 0) return false
    onBeginEdit()
    onChange({
      ...schematic,
      wires: schematic.wires.filter((_, k) => !highlightedWires.has(k)),
      labels: schematic.labels.filter((_, k) => !highlightedLabels.has(k)),
    })
    onSelect(selectionOf(selectedRefs(selection), selectedNets(selection)))
    return true
  }

  /** Keys while drawing or with wiring selected; returns true when handled. */
  const handleKey = (e: KeyboardEvent): boolean => {
    if (draft && e.key === ' ') {
      setDraft({ ...draft, horizontalFirst: !(draft.horizontalFirst ?? true) })
      return true
    }
    if (draft && e.key === 'Escape') {
      // Keeps the corners placed so far; only the leg to the pointer is dropped.
      finishDraft(draft.points)
      return true
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return removeSelectedWiring()
    return false
  }
  const handleKeyRef = useRef(handleKey)
  handleKeyRef.current = handleKey
  useEffect(() => {
    // Capture phase, so a key used here (Space while drawing) does not also reach the app's shortcuts.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (!handleKeyRef.current(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // ---------- Drawing ----------

  const conflictPoints = new Set(nets.conflicts.flatMap((c) => c.points.map(pointKey)))
  const px = 1 / view.scale
  const pitch = gridPitch(view.scale, gridPitches(SCHEMATIC_GRID, gridLinesPerMajor))
  const preview = draft && draftPath(draft)
  return (
    <div className="schematic-view">
      <svg
        ref={svgRef}
        className={['schematic', `tool-${tool}`, (overPoint || draft) && 'over-point', ...layerClasses(layers, { dimFaint: false })].filter(Boolean).join(' ')}
        style={layerOpacities(layers)}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => draft && finishDraft(draft.points)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <g transform={`translate(${view.ox} ${view.oy}) scale(${view.scale})`}>
          {/* No origin axes or rulers: a schematic has no physical position, they only distract. */}
          <ViewportGrid view={view} size={size} pitch={pitch} linesPerMajor={gridLinesPerMajor} axes={false} />
          {schematic.wires.map((w, k) => {
            const selected = highlightedWires.has(k)
            return (
              <g
                key={k}
                className={selected ? 'sch-wire-item selected' : 'sch-wire-item'}
                onPointerDown={(e) => pressItem(e, { kind: 'wire', index: k })}
              >
                <line className="sch-wire-hit" x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} strokeWidth={8 * px} />
                <line className="sch-wire" x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} />
              </g>
            )
          })}
          {parts.map(({ component, placement, pins }) => (
            <SchematicPart
              key={placement.ref}
              component={component}
              placement={placement}
              pins={pins}
              selected={highlightedRefs.has(placement.ref)}
              onPointerDown={(e) => pressItem(e, { kind: 'part', ref: placement.ref })}
              onTextPointerDown={(e) => pressPartText(e, component, placement)}
            />
          ))}
          {nets.junctions.map((p) => (
            <circle key={pointKey(p)} className="sch-junction" cx={p.x} cy={p.y} r={0.55} />
          ))}
          {wiring.points.map((p) => (
            <rect key={pointKey(p)} className="sch-point selected" x={p.x - 0.6} y={p.y - 0.6} width={1.2} height={1.2} pointerEvents="none" />
          ))}
          {schematic.labels.map((label, k) => {
            const selected = highlightedLabels.has(k)
            const conflict = conflictPoints.has(pointKey(label))
            return (
              <LabelMark
                key={k}
                label={label}
                direction={labelDirection(label, parts, schematic.wires)}
                className={['sch-label', selected && 'selected', conflict && 'conflict'].filter(Boolean).join(' ')}
                onPointerDown={(e) => pressItem(e, { kind: 'label', index: k })}
                onDoubleClick={() => renameLabel(k)}
              />
            )
          })}
          {preview && <polyline className="sch-wire preview" points={preview.map((q) => `${q.x},${q.y}`).join(' ')} />}
          {marquee && (
            <rect
              className="marquee"
              x={marquee.rect.x}
              y={marquee.rect.y}
              width={marquee.rect.w}
              height={marquee.rect.h}
              strokeWidth={px}
              // Dashed while it selects what it touches (dragged right to left), solid for what lies inside.
              strokeDasharray={marquee.crossing ? `${4 * px} ${3 * px}` : undefined}
              pointerEvents="none"
            />
          )}
        </g>
      </svg>
      {nets.conflicts.length > 0 && (
        <div className="schematic-conflicts" role="alert">
          {nets.conflicts.map((c) => `Shorted: ${c.names.join(' + ')}`).join(' · ')}
        </div>
      )}
      {parts.length === 0 && <p className="schematic-empty">Import a netlist to see its schematic.</p>}
    </div>
  )
}
