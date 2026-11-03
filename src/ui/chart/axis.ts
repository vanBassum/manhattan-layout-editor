// The arithmetic behind a chart's axes: round tick values, and a visible window on the x-axis
// that zooms and pans within the data.

/** A stretch of an axis, from `min` to `max`. */
export interface Range {
  min: number
  max: number
}

/** The smallest window zooming goes to, as a share of the full range. */
const MIN_ZOOM_SHARE = 1e-4

/** Round tick values covering `range`, about `count` of them, in steps of 1, 2 or 5 times a power of ten. */
export function niceTicks({ min, max }: Range, count: number): { ticks: number[]; step: number } {
  const rough = (max - min) / count
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((f) => f * power).find((s) => s >= rough)!
  const ticks: number[] = []
  // Rounded to 12 digits, so 3 × 0.2 shows up as 0.6 and not 0.6000000000000001.
  for (let k = Math.ceil(min / step); k * step <= max + step * 1e-9; k++) ticks.push(Number((k * step).toPrecision(12)))
  return { ticks, step }
}

/** The index of the value in sorted `values` nearest `value`. */
export function nearestIndex(values: number[], value: number): number {
  let low = 0
  let high = values.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (values[middle] < value) low = middle
    else high = middle
  }
  return value - values[low] < values[high] - value ? low : high
}

/** `window` moved inside `full`, keeping its size; the full range when it is wider. */
function keptInside(window: Range, full: Range): Range {
  const size = window.max - window.min
  if (size >= full.max - full.min) return full
  if (window.min < full.min) return { min: full.min, max: full.min + size }
  if (window.max > full.max) return { min: full.max - size, max: full.max }
  return window
}

/**
 * `window` zoomed by `factor` (below 1 zooms in) around `anchor`, which stays where it is on screen,
 * kept inside `full` and no smaller than a ten-thousandth of it.
 */
export function zoomed(window: Range, full: Range, factor: number, anchor: number): Range {
  const fullSize = full.max - full.min
  const size = Math.min(fullSize, Math.max(fullSize * MIN_ZOOM_SHARE, (window.max - window.min) * factor))
  const before = (anchor - window.min) / (window.max - window.min)
  return keptInside({ min: anchor - before * size, max: anchor - before * size + size }, full)
}

/** `window` shifted by `delta`, kept inside `full`. */
export const panned = (window: Range, full: Range, delta: number): Range => keptInside({ min: window.min + delta, max: window.max + delta }, full)

/**
 * The indices of sorted `values` worth drawing for `window`: those inside it plus one either side,
 * so a line still runs to the edges.
 */
export function visibleSlice(values: number[], window: Range): { start: number; end: number } {
  const start = Math.max(0, nearestIndex(values, window.min) - 1)
  const end = Math.min(values.length, nearestIndex(values, window.max) + 2)
  return { start, end }
}
