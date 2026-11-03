import type { SpiceRun } from './spiceEngine'
import type { WorkerAnswer } from './ngspiceWorker'

export type { SpiceRun } from './spiceEngine'

/** How long a run, including loading ngspice the first time, may take before it counts as stuck. */
const RUN_TIMEOUT_MS = 5_000

let worker: Worker | undefined
/** The worker's engine holds one netlist at a time, so runs wait for each other. */
let lastRun: Promise<unknown> = Promise.resolve()

const startWorker = () => new Worker(new URL('./ngspiceWorker.ts', import.meta.url), { type: 'module' })

/** Asks the worker to run `netlist`; a run that takes too long ends the worker, so the next run starts afresh. */
function askWorker(netlist: string): Promise<SpiceRun> {
  worker ??= startWorker()
  const current = worker
  return new Promise<SpiceRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      current.terminate()
      worker = undefined
      reject(new Error(`ngspice gave no answer within ${RUN_TIMEOUT_MS / 1000} s, so it was stopped`))
    }, RUN_TIMEOUT_MS)
    current.onmessage = (event: MessageEvent<WorkerAnswer>) => {
      clearTimeout(timer)
      if ('error' in event.data) reject(new Error(event.data.error))
      else resolve(event.data.run)
    }
    current.onerror = (event) => {
      clearTimeout(timer)
      current.terminate()
      worker = undefined
      reject(new Error(`ngspice could not start: ${event.message}`))
    }
    current.postMessage(netlist)
  })
}

/** Runs `netlist` in ngspice; throws with ngspice's own messages when it finds no answer. */
export function runSpice(netlist: string): Promise<SpiceRun> {
  const run = lastRun.then(() => askWorker(netlist))
  lastRun = run.catch(() => undefined)
  return run
}
