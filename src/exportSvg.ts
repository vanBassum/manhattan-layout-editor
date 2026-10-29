import { boundsOf, inflate, outlinePath } from './geometry'
import type { Island } from './types'

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4)

/**
 * One closed contour per island, offset outward by isolation/2 and stroked with width = isolation.
 * The burned band therefore runs from the copper edge to isolation mm outside it,
 * leaving the island itself fully intact. Units are millimeters (1 user unit = 1 mm).
 */
export function exportSvg(islands: Island[], isolation: number): string {
  const half = isolation / 2
  const contours = islands.map((island) => ({
    net: island.net,
    rects: island.rects.map((r) => inflate(r, half)),
  }))
  const bounds = boundsOf(contours.flatMap((c) => c.rects)) ?? { x: 0, y: 0, w: 1, h: 1 }
  const view = inflate(bounds, isolation + 1)

  const paths = contours
    .map((c) => `    <path data-net="${escapeXml(c.net)}" d="${outlinePath(c.rects)}"><title>${escapeXml(c.net)}</title></path>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(view.w)}mm" height="${fmt(view.h)}mm" viewBox="${fmt(view.x)} ${fmt(view.y)} ${fmt(view.w)} ${fmt(view.h)}">
  <!-- Isolation contours. Stroke width = isolation gap (${fmt(isolation)} mm). -->
  <g id="isolation" fill="none" stroke="#000000" stroke-width="${fmt(isolation)}" stroke-linejoin="miter" stroke-linecap="square">
${paths}
  </g>
</svg>
`
}

export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
