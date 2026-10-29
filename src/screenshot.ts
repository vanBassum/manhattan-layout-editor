import type { Rect } from './types'

const SVG_NS = 'http://www.w3.org/2000/svg'
const MAX_PIXELS = 1600
const MAX_PIXELS_PER_MM = 12
const MARGIN_MM = 3

/**
 * Renders the editor's canvas to a PNG (base64, no data: prefix), framed on `bounds` instead of
 * the current view. Works on a copy of the live SVG so it shows exactly what the editor draws.
 */
export async function canvasToPng(svg: SVGSVGElement, bounds: Rect): Promise<string> {
  const frame = { x: bounds.x - MARGIN_MM, y: bounds.y - MARGIN_MM, w: bounds.w + 2 * MARGIN_MM, h: bounds.h + 2 * MARGIN_MM }
  const scale = Math.min(MAX_PIXELS / frame.w, MAX_PIXELS / frame.h, MAX_PIXELS_PER_MM)
  const width = Math.round(frame.w * scale)
  const height = Math.round(frame.h * scale)

  const copy = svg.cloneNode(true) as SVGSVGElement
  copy.setAttribute('xmlns', SVG_NS)
  copy.setAttribute('viewBox', `${frame.x} ${frame.y} ${frame.w} ${frame.h}`)
  copy.setAttribute('width', String(width))
  copy.setAttribute('height', String(height))
  // Layer toggles are a view preference; the picture always shows every layer.
  copy.setAttribute('class', 'canvas')
  copy.removeAttribute('style')
  const content = copy.querySelector(':scope > g')!
  content.removeAttribute('transform')
  // The grid only covers the on-screen area, and hover fading should not end up in the picture.
  copy.querySelector('.grid')?.remove()
  copy.querySelectorAll('[opacity]').forEach((element) => element.removeAttribute('opacity'))

  const background = document.createElementNS(SVG_NS, 'rect')
  Object.entries({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, fill: '#ffffff' }).forEach(([k, v]) =>
    background.setAttribute(k, String(v)),
  )
  content.prepend(background)

  // Text styling lives in the page stylesheet, which a standalone image does not see.
  const style = document.createElementNS(SVG_NS, 'style')
  style.textContent = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText)
      } catch {
        return []
      }
    })
    .join('\n')
  copy.prepend(style)

  const image = new Image()
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy))
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}
