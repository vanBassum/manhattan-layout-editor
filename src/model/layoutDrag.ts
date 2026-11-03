import { draggedTarget, moveBoundary, resizeRect, type Boundary, type Side } from './boundary'
import { snapToGrid } from './geometry'
import { gridDelta, moveGroup, movePart, moveRects, replaceIslandRects, toLocal, type MovingPart } from './layout'
import type { Island, Layout, Point, Rect } from './types'

/**
 * A drag that edits the PCB layout, holding what it moves as it was when the drag started.
 * boundary: a cut between islands or an island's outline edge, moving the copper on both sides.
 * resize: one rectangle of an island, whose dragged sides move as boundaries. lead: a lead's end.
 * part: one part. group: the parts and islands of a multi-selection.
 */
export type LayoutDrag =
  | { kind: 'boundary'; boundary: Boundary; islands: Island[] }
  | { kind: 'island'; net: string; rects: Rect[] }
  | { kind: 'resize'; net: string; rectIndex: number; sides: Side[]; islands: Island[] }
  | { kind: 'lead'; ref: string; pin: string; origin: Point }
  | { kind: 'part'; part: MovingPart }
  | { kind: 'group'; parts: MovingPart[]; islands: Island[] }

/** The layout with the drag applied: `delta` is the pointer movement since the drag started. */
export function draggedLayout(layout: Layout, drag: LayoutDrag, delta: Point, snap: number): Layout {
  const dx = snapToGrid(delta.x, snap)
  const dy = snapToGrid(delta.y, snap)
  switch (drag.kind) {
    case 'boundary':
      return { ...layout, islands: moveBoundary(drag.islands, drag.boundary, draggedTarget(drag.boundary, delta, snap)) }
    case 'island': {
      const onGrid = gridDelta(drag.rects, delta.x, delta.y, snap)
      return replaceIslandRects(layout, drag.net, moveRects(drag.rects, onGrid.x, onGrid.y))
    }
    case 'resize':
      return { ...layout, islands: resizeRect(drag.islands, drag.net, drag.rectIndex, drag.sides, delta, snap) }
    case 'lead': {
      // Stored relative to the body as it is now (it may have rotated mid-drag), so the bent lead follows the component.
      const end = { x: drag.origin.x + dx, y: drag.origin.y + dy }
      return {
        ...layout,
        placements: layout.placements.map((pl) =>
          pl.ref === drag.ref ? { ...pl, leads: { ...pl.leads, [drag.pin]: toLocal(end, pl) } } : pl,
        ),
      }
    }
    case 'part':
      return {
        ...layout,
        placements: layout.placements.map((pl) => (pl.ref === drag.part.placement.ref ? movePart(pl, drag.part, dx, dy) : pl)),
      }
    case 'group': {
      // Parts move by the same delta as the islands, so they stay where they sit on the copper.
      const onGrid = drag.islands.length > 0 ? gridDelta(drag.islands[0].rects, delta.x, delta.y, snap) : { x: dx, y: dy }
      return moveGroup(layout, drag.parts, drag.islands, onGrid.x, onGrid.y)
    }
  }
}
