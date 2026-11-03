const PREFIXES: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']]

/** "3.84 mA", "5.18 V", "-12.0 µA", "1.00 MHz": three significant digits with the prefix that fits. */
export function formatQuantity(value: number, unit: string): string {
  // Below a femto is rounding noise from the solver, e.g. the average of a symmetric wave.
  if (Math.abs(value) < 1e-15) return `0 ${unit}`
  const size = Math.abs(value)
  const [scale, prefix] = PREFIXES.find(([scale]) => size >= scale) ?? PREFIXES[PREFIXES.length - 1]
  return `${(value / scale).toPrecision(3)} ${prefix}${unit}`
}

/** The prefix and scale that suit values up to `largest`, e.g. µs for 5e-6 s, so an axis shares one unit. */
export function unitFor(largest: number): { scale: number; prefix: string } {
  const [scale, prefix] = PREFIXES.find(([scale]) => Math.abs(largest) >= scale) ?? PREFIXES[PREFIXES.length - 1]
  return { scale, prefix }
}
