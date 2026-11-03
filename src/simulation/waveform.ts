export interface Measurements {
  max: number
  min: number
  peakToPeak: number
  /** The mean over time; ngspice's time steps are uneven, so each value counts for the time it lasts. */
  average: number
}

/**
 * The waveform at `count` evenly spaced times from its first to its last, linearly interpolated:
 * ngspice's own time steps are uneven and far too many to hand around.
 */
export function resample(time: number[], values: number[], count: number): { time: number[]; values: number[] } {
  const start = time[0]
  const end = time[time.length - 1]
  const times = Array.from({ length: count }, (_, k) => (count === 1 ? start : start + ((end - start) * k) / (count - 1)))
  let i = 0
  const sampled = times.map((t) => {
    while (i < time.length - 2 && time[i + 1] < t) i++
    const span = time[i + 1] - time[i]
    const share = span > 0 ? Math.min(1, Math.max(0, (t - time[i]) / span)) : 0
    return values[i] + (values[i + 1] - values[i]) * share
  })
  return { time: times, values: sampled }
}

/** Max, min, peak-to-peak and time-weighted average of a waveform sampled at `time` (seconds, rising). */
export function measure(time: number[], volts: number[]): Measurements {
  const max = Math.max(...volts)
  const min = Math.min(...volts)
  let area = 0
  for (let k = 1; k < time.length; k++) area += ((volts[k] + volts[k - 1]) / 2) * (time[k] - time[k - 1])
  const duration = time[time.length - 1] - time[0]
  return { max, min, peakToPeak: max - min, average: duration > 0 ? area / duration : volts[0] }
}
