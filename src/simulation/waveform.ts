export interface Measurements {
  max: number
  min: number
  peakToPeak: number
  /** The mean over time; ngspice's time steps are uneven, so each value counts for the time it lasts. */
  average: number
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
