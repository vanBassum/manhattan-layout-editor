import type { Point, Rect } from './types'

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d }
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  const eps = 1e-6
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function nearestPointOnRects(rects: Rect[], p: Point): Point {
  let best = p
  let bestDistance = Infinity
  for (const r of rects) {
    const q = { x: clamp(p.x, r.x, r.x + r.w), y: clamp(p.y, r.y, r.y + r.h) }
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < bestDistance) {
      bestDistance = d
      best = q
    }
  }
  return best
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const maxX = Math.max(...rects.map((r) => r.x + r.w))
  const maxY = Math.max(...rects.map((r) => r.y + r.h))
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Clockwise on screen (SVG coordinates: y points down). Multiples of 90 degrees are exact. */
export function rotatePoint(p: Point, degrees: number): Point {
  switch (((degrees % 360) + 360) % 360) {
    case 0:
      return p
    case 90:
      return { x: -p.y, y: p.x }
    case 180:
      return { x: -p.x, y: -p.y }
    case 270:
      return { x: p.y, y: -p.x }
  }
  const radians = (degrees * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }
}

/** True when segments ab and cd cross somewhere other than at a shared endpoint. */
export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = side(c, d, a)
  const d2 = side(c, d, b)
  const d3 = side(a, b, c)
  const d4 = side(a, b, d)
  return d1 * d2 < 0 && d3 * d4 < 0
}

const roundKey = (v: number) => Math.round(v * 1e4) / 1e4

/**
 * Outline of the union of axis-aligned rectangles, as closed loops of corner points.
 * Works on the grid formed by all rectangle edges: every covered grid cell contributes
 * the sides that border an uncovered cell, and those sides are chained into loops.
 */
export function unionOutline(rects: Rect[]): Point[][] {
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w].map(roundKey)))].sort((a, b) => a - b)
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.h].map(roundKey)))].sort((a, b) => a - b)
  const columns = xs.length - 1
  const rows = ys.length - 1
  const coveredCells: boolean[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const center = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 }
      coveredCells.push(rects.some((r) => rectContains(r, center)))
    }
  }
  const covered = (i: number, j: number) => i >= 0 && j >= 0 && i < columns && j < rows && coveredCells[j * columns + i]

  // Directed edges keyed by start corner "i,j"; clockwise around covered area.
  const edges = new Map<string, string[]>()
  const addEdge = (i1: number, j1: number, i2: number, j2: number) => {
    const key = `${i1},${j1}`
    const list = edges.get(key) ?? []
    list.push(`${i2},${j2}`)
    edges.set(key, list)
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      if (!covered(i, j)) continue
      if (!covered(i, j - 1)) addEdge(i, j, i + 1, j)
      if (!covered(i + 1, j)) addEdge(i + 1, j, i + 1, j + 1)
      if (!covered(i, j + 1)) addEdge(i + 1, j + 1, i, j + 1)
      if (!covered(i - 1, j)) addEdge(i, j + 1, i, j)
    }
  }

  const loops: Point[][] = []
  for (const [start, ends] of edges) {
    while (ends.length > 0) {
      const corners: [number, number][] = []
      let current = start
      do {
        corners.push(current.split(',').map(Number) as [number, number])
        current = edges.get(current)!.pop()!
      } while (current !== start)
      loops.push(dropCollinear(corners).map(([i, j]) => ({ x: xs[i], y: ys[j] })))
    }
  }
  return loops
}

function dropCollinear(corners: [number, number][]): [number, number][] {
  return corners.filter((c, k) => {
    const prev = corners[(k - 1 + corners.length) % corners.length]
    const next = corners[(k + 1) % corners.length]
    const straightVertical = prev[0] === c[0] && c[0] === next[0]
    const straightHorizontal = prev[1] === c[1] && c[1] === next[1]
    return !straightVertical && !straightHorizontal
  })
}

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)

export function outlinePath(rects: Rect[]): string {
  return unionOutline(rects)
    .map((loop) => 'M' + loop.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join('L') + 'Z')
    .join('')
}
