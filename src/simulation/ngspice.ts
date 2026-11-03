import type { Simulation } from 'eecircuit-engine'
import type { SpiceVector } from './spiceNetlist'

// ngspice compiled to WebAssembly. It is about 20 MB, so it is only loaded on the first run.

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

export interface SpiceRun {
  vectors: SpiceVector[]
  /** What ngspice warned about while still finding an answer, e.g. a node it found hard to solve. */
  warnings: string[]
}

/** Runs `netlist` in ngspice; throws with ngspice's own messages when it finds no answer. */
export function runSpice(netlist: string): Promise<SpiceRun> {
  const run = lastRun.then(async () => {
    const simulation = await startEngine()
    simulation.setNetList(netlist)
    const result = await simulation.runSim()
    const messages = simulation.getError().map((line) => line.trim()).filter(Boolean)
    if (messages.some((line) => /error/i.test(line))) throw new Error(messages.join('\n'))
    return { vectors: result.data, warnings: [...new Set(messages.filter((line) => /^warning/i.test(line)))] }
  })
  lastRun = run.catch(() => undefined)
  return run
}
