import type { Simulation } from 'eecircuit-engine'
import type { SpiceVector } from './spiceNetlist'

// ngspice compiled to WebAssembly. It is about 20 MB, so it is only loaded on the first run.

/** How long loading or one run may take before it counts as stuck. */
const STEP_TIMEOUT_MS = 5_000

let engine: Promise<Simulation> | undefined
/** One engine holds one netlist at a time, so runs wait for each other. */
let lastRun: Promise<unknown> = Promise.resolve()

function startEngine(): Promise<Simulation> {
  engine ??= import('eecircuit-engine').then(async ({ Simulation }) => {
    const simulation = new Simulation()
    await simulation.start()
    return simulation
  })
  return engine
}

class StuckError extends Error {}

/** `step`, or a StuckError naming it when it has not finished in time. */
function withinTimeout<T>(step: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StuckError(`ngspice got stuck ${what} (no answer within ${STEP_TIMEOUT_MS / 1000} s)`)), STEP_TIMEOUT_MS)
  })
  return Promise.race([step, timeout]).finally(() => clearTimeout(timer))
}

export interface SpiceRun {
  vectors: SpiceVector[]
  /** What ngspice warned about while still finding an answer, e.g. a node it found hard to solve. */
  warnings: string[]
}

/** Runs `netlist` in ngspice; throws with ngspice's own messages when it finds no answer. */
export function runSpice(netlist: string): Promise<SpiceRun> {
  const run = lastRun.then(async () => {
    try {
      const simulation = await withinTimeout(startEngine(), 'loading')
      simulation.setNetList(netlist)
      const result = await withinTimeout(simulation.runSim(), 'simulating')
      const messages = simulation.getError().map((line) => line.trim()).filter(Boolean)
      if (messages.some((line) => /error/i.test(line))) throw new Error(messages.join('\n'))
      return { vectors: result.data, warnings: [...new Set(messages.filter((line) => /^warning/i.test(line)))] }
    } catch (e) {
      // A stuck or broken engine is dropped, so the next run starts a fresh one.
      if (e instanceof StuckError) engine = undefined
      throw e
    }
  })
  lastRun = run.catch(() => undefined)
  return run
}
