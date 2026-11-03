import type { Simulation } from 'eecircuit-engine'
import type { SpiceVector } from './spiceNetlist'

// ngspice compiled to WebAssembly, about 20 MB. The editor runs it in a worker (ngspiceWorker.ts),
// tests run it directly.

let engine: Promise<Simulation> | undefined

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

/**
 * Runs `netlist` in this thread's ngspice; throws with ngspice's own messages when it finds no answer.
 * One engine holds one netlist at a time, so a run must finish before the next one starts.
 */
export async function runInEngine(netlist: string): Promise<SpiceRun> {
  const simulation = await startEngine()
  simulation.setNetList(netlist)
  const result = await simulation.runSim()
  const messages = simulation.getError().map((line) => line.trim()).filter(Boolean)
  if (messages.some((line) => /error/i.test(line))) throw new Error(messages.join('\n'))
  return { vectors: result.data, warnings: [...new Set(messages.filter((line) => /^warning/i.test(line)))] }
}
