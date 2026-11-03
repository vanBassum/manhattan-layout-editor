/// <reference lib="webworker" />
import { errorText } from '../errorText'
import { runInEngine } from './spiceEngine'

// ngspice computes without yielding, so it runs here: the editor stays responsive and can stop a
// run that takes too long by ending this worker.

export type WorkerAnswer = { run: Awaited<ReturnType<typeof runInEngine>> } | { error: string }

self.onmessage = async (event: MessageEvent<string>) => {
  let answer: WorkerAnswer
  try {
    answer = { run: await runInEngine(event.data) }
  } catch (e) {
    answer = { error: errorText(e) }
  }
  self.postMessage(answer)
}
