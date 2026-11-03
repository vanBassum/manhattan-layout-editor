import { describe, expect, it } from 'vitest'
import { exportSvg } from './exportSvg'
import type { Island } from './types'

const BOARD: Island[] = [
  { net: 'A', rects: [{ x: 0, y: 0, w: 10, h: 5 }] },
  { net: 'B&C', rects: [{ x: 10, y: 0, w: 10, h: 5 }] },
]

describe('exportSvg', () => {
  it('strokes every island outline with the isolation width, in millimeters', () => {
    expect(exportSvg(BOARD, 0.4)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="22.8mm" height="7.8mm" viewBox="-1.4 -1.4 22.8 7.8">
  <!-- Isolation cuts, centered on the island outlines. Stroke width = isolation (0.4 mm). -->
  <g id="isolation" fill="none" stroke="#000000" stroke-width="0.4" stroke-linejoin="miter" stroke-linecap="square">
    <path data-net="A" d="M0 0L10 0L10 5L0 5Z"><title>A</title></path>
    <path data-net="B&amp;C" d="M10 0L20 0L20 5L10 5Z"><title>B&amp;C</title></path>
  </g>
</svg>
`)
  })
})
