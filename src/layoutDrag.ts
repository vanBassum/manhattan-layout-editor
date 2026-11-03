import { followResize, moveCut, resizeRect, type Cut, type CutNeighbour, type Side } from './cuts'
import { snapToGrid } from './geometry'
import { gridDelta, moveGroup, movePart, moveRects, replaceIslandRects, replaceRect, toLocal, type MovingPart } from './layout'
import { moveIslandEdge, type IslandEdge } from './raster'
import type { Island, Layout, Point, Rect } from './types'

/**
 * A drag that edits the PCB layout, holding what it moves as it was when the drag started.
 * edge: an island's outline edge. cut: the cut between islands, moving both sides. resize: one
 * rectangle of an island, with the rectangles of other nets on its dragged sides. lead: a lead's
 * end. part: one part. group: the parts and islands of a multi-selection.
 */
export type LayoutDrag =
  | { kind: 'edge'; net: string; edge: IslandEdge; islands: Island[] }
  | { kind: 'island'; net: string; rects: Rect[] }
  | { kind: 'cut'; cut: Cut; islands: Island[] }
  | { kind: 'resize'; net: string; rectIndex: number; sides: Side[]; rect: Rect; neighbours: CutNeighbour[] }
  | { kind: 'lead'; ref: string; pin: string; origin: Point }
  | { kind: 'part'; part: MovingPart }
  | { kind: 'group'; parts: MovingPart[]; islands: Island[] }

/** The layout with the drag applied: `delta` is the pointer movement since the drag started. */
export function draggedLayout(layout: Layout, drag: LayoutDrag, delta: Point, snap: number): Layout {
  const dx = snapToGrid(delta.x, snap)
  const dy = snapToGrid(delta.y, snap)
  switch (drag.kind) {
    case 'edge': {
      const target = snapToGrid(drag.edge.at + (drag.edge.axis === 'x' ? delta.x : delta.y), snap)
      return { ...layout, islands: moveIslandEdge(drag.islands, drag.net, drag.edge, target) }
    }
    case 'island': {
      const onGrid = gridDelta(drag.rects, delta.x, delta.y, snap)
      return replaceIslandRects(layout, drag.net, moveRects(drag.rects, onGrid.x, onGrid.y))
    }
    case 'cut': {
      const target = snapToGrid(drag.cut.at + (drag.cut.axis === 'x' ? delta.x : delta.y), snap)
      return { ...layout, islands: moveCut(drag.islands, drag.cut, target) }
    }
    case 'resize': {
      const resized = resizeRect(drag.rect, drag.sides, delta.x, delta.y, snap)
      return drag.neighbours.reduce(
        (next, n) => replaceRect(next, n.net, n.rectIndex, followResize(n, resized)),
        replaceRect(layout, drag.net, drag.rectIndex, resized),
      )
    }
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
