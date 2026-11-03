// The simulation as an AI agent works with it: what is set up and what is missing, changes to the
// set-up, and runs whose answers are numbers rather than plots.

import { errorText } from '../errorText'
import { checkedSimulation } from '../documents/projectFormat'
import { isJsonObject } from '../model/netlist'
import { projectSchematicNets } from '../model/schematic'
import type { Project, Simulation } from '../model/types'
import { runSpice } from '../simulation/ngspice'
import {
  operatingPointNetlist,
  readOperatingPoint,
  readTransient,
  spiceCircuit,
  transientNetlist,
  trimmersOf,
  valuesNeedingModels,
  waveSources,
} from '../simulation/spiceNetlist'
import { measure, resample } from '../simulation/waveform'
import type { Args } from './agentCommands'

const NO_SIMULATION: Simulation = { sources: [], models: {} }

/** The schematic's nets: the schematic is what gets simulated, as in the editor. */
const schematicNetlist = (project: Project) => projectSchematicNets(project).netlist

/** The set-up, what the schematic needs from it, and why it cannot run yet. */
export function describeSimulation(project: Project) {
  const simulation = project.simulation ?? NO_SIMULATION
  const netlist = schematicNetlist(project)
  let problems: string[] = []
  try {
    spiceCircuit(netlist, project.definitions, simulation)
  } catch (e) {
    problems = errorText(e).split('\n')
  }
  return {
    simulation,
    needs: {
      models: [...valuesNeedingModels(netlist)].map(([value, refs]) => ({ value, refs, present: simulation.models[value] !== undefined })),
      trimmers: trimmersOf(netlist, project.definitions).map((t) => ({ ref: t.ref, value: t.value, position: simulation.trimmers?.[t.ref] ?? null })),
    },
    problems,
  }
}

/**
 * The simulation with the agent's changes: `sources` replaces the list; `models` and `trimmers` are
 * merged by key, where null removes one. Checked as a project file's simulation is.
 */
export function changedSimulation(project: Project, args: Args): Simulation {
  const current = project.simulation ?? NO_SIMULATION
  const merged = (base: Record<string, unknown>, changes: unknown, name: string) => {
    if (changes === undefined) return base
    if (!isJsonObject(changes)) throw new Error(`"${name}" must be an object`)
    const next = { ...base }
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key]
      else next[key] = value
    }
    return next
  }
  const next = {
    sources: args.sources ?? current.sources,
    models: merged(current.models, args.models, 'models'),
    trimmers: merged(current.trimmers ?? {}, args.trimmers, 'trimmers'),
  }
  return checkedSimulation(next)!
}

/** Samples of a transient waveform an agent gets at most: enough to see a shape, not a flood. */
const MAX_SAMPLES = 1000

/** Runs the operating point or a transient of the schematic and answers with numbers. */
export async function runSimulation(project: Project, args: Args) {
  const analysis = args.analysis
  if (analysis !== 'operating_point' && analysis !== 'transient') throw new Error('"analysis" must be "operating_point" or "transient"')
  const circuit = spiceCircuit(schematicNetlist(project), project.definitions, project.simulation ?? NO_SIMULATION)

  if (analysis === 'operating_point') {
    const { vectors, warnings } = await runSpice(operatingPointNetlist(circuit))
    const point = readOperatingPoint(circuit, vectors)
    return { volts: Object.fromEntries(point.volts), sources: point.dcSources, transistors: point.transistors, warnings }
  }

  if (waveSources(circuit.sources).length === 0) throw new Error('A transient needs a square or sine source')
  const { vectors, warnings } = await runSpice(transientNetlist(circuit))
  const trace = readTransient(circuit, vectors)
  const wanted = args.nets === undefined ? [...trace.volts.keys()] : (args.nets as unknown[]).map(String)
  const unknown = wanted.filter((net) => !trace.volts.has(net))
  if (unknown.length) throw new Error(`No such net: ${unknown.join(', ')}. Nets: ${[...trace.volts.keys()].join(', ')}`)
  const samples = args.samples === undefined ? 0 : Number(args.samples)
  if (!Number.isInteger(samples) || samples < 0 || samples > MAX_SAMPLES) throw new Error(`"samples" must be a whole number from 0 to ${MAX_SAMPLES}`)
  const nets = wanted.map((net) => {
    const volts = trace.volts.get(net)!
    return { net, ...measure(trace.time, volts), ...(samples ? { samples: resample(trace.time, volts, samples).values } : {}) }
  })
  return {
    seconds: trace.time[trace.time.length - 1],
    ...(samples ? { sampleTimes: resample(trace.time, trace.time, samples).values } : {}),
    nets,
    warnings,
  }
}
