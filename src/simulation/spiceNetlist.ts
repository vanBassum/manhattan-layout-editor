import { resolvedDefinition } from '../model/definitions'
import { refPrefix } from '../model/footprintTemplates'
import { isGroundNet, isRealNet } from '../model/netlist'
import type { ComponentDefinition, NetComponent, Netlist, Simulation, Source, WaveSource } from '../model/types'

// Turns the schematic into an ngspice netlist and reads ngspice's answers back onto nets and parts.

const SCALES: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }

/**
 * A part value as a number: "12k", "4k7", "2.2uF", "80Ω", "100n", "2R2"; also a frequency or time, "1MHz", "2.5 µs". M is mega, as written on
 * parts, where SPICE would read milli; that is why values go to ngspice as plain numbers.
 * Undefined for text that is no value.
 */
export function partValue(text: string): number | undefined {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([pnuµmkKMGR]?)(\d*)\s*(Ω|ohms?|F|Hz|H|s)?$/)
  if (!match) return undefined
  const [, number, prefix, decimals] = match
  // Digits after the prefix are decimals ("4k7"), so only after a prefix and a whole number.
  if (decimals && (number.includes('.') || !prefix)) return undefined
  return Number(decimals ? `${number}.${decimals}` : number) * SCALES[prefix]
}

export interface SpiceTransistor {
  ref: string
  /** The element name ngspice knows it by. */
  element: string
  collector: string
  base: string
  emitter: string
}

export interface SpiceCircuit {
  /** The circuit for ngspice, without an analysis or `.end`. */
  lines: string[]
  /** The ngspice node of each net; every ground net is node 0. */
  nodes: Map<string, string>
  transistors: SpiceTransistor[]
  /** Each source with the element ngspice knows it by. */
  sources: (Source & { element: string })[]
}

/** The wave sources, slowest first: the slowest sets how long a transient run lasts. */
export const waveSources = (sources: Source[]): WaveSource[] =>
  sources.filter((s): s is WaveSource => s.shape !== 'dc').sort((a, b) => a.hertz - b.hertz)

/**
 * The source's voltage for ngspice. A wave starts at 0 V, like a generator that was off, so the
 * operating point ngspice finds before a run is the circuit at rest. A square wave is a repeating
 * piecewise-linear wave because a PULSE would start at its low level; its first edge, from 0 V,
 * swings half as far and so takes half the edge time.
 */
function sourceVoltage(source: Source): string {
  if (source.shape === 'dc') return `DC ${source.volts}`
  if (source.shape === 'sine') return `DC 0 SIN(0 ${source.volts} ${source.hertz})`
  const { volts, hertz, edgeSeconds } = source
  const period = 1 / hertz
  const halfEdge = edgeSeconds / 2
  const points = [
    [0, 0],
    [halfEdge, volts],
    [period / 2 - halfEdge, volts],
    [period / 2 + halfEdge, -volts],
    [period - halfEdge, -volts],
    [period + halfEdge, volts],
  ]
  // r= repeats the wave from the end of its first rising edge.
  return `DC 0 PWL(${points.flat().join(' ')}) r=${halfEdge}`
}

/**
 * A node name for each net that ngspice accepts and gives back unchanged: it lowercases names, so a
 * net is only called by its own name when that stays unique in lower case.
 */
function nodeNames(nets: string[]): Map<string, string> {
  const nodes = new Map<string, string>()
  const taken = new Set(['0'])
  nets.forEach((net, k) => {
    if (isGroundNet(net)) {
      nodes.set(net, '0')
      return
    }
    const own = net.toLowerCase()
    const node = /^[a-z_][a-z0-9_]*$/.test(own) && !taken.has(own) ? own : `n${k + 1}`
    taken.add(node)
    nodes.set(net, node)
  })
  return nodes
}

/** The element name: the ref when it already starts with the element's letter, e.g. R1 or Q2; else prefixed, e.g. DLED1. */
const elementName = (letter: string, ref: string) => (ref.toUpperCase().startsWith(letter) ? ref : `${letter}${ref}`)

const PASSIVES: Record<string, string> = { R: 'R', RL: 'R', C: 'C', L: 'L' }

const isTransistor = (component: NetComponent) => refPrefix(component.ref) === 'Q'
const isDiode = (component: NetComponent) => ['D', 'LED'].includes(refPrefix(component.ref))

/** The part values that need a SPICE model, each with the refs of its parts, in netlist order. */
export function valuesNeedingModels(netlist: Netlist): Map<string, string[]> {
  const values = new Map<string, string[]>()
  for (const c of netlist.components) {
    if (!isTransistor(c) && !isDiode(c)) continue
    values.set(c.value, [...(values.get(c.value) ?? []), c.ref])
  }
  return values
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const definesModel = (text: string, name: string) => new RegExp(`^\\s*\\.model\\s+${escapeRegExp(name)}\\s`, 'im').test(text)

/**
 * The ngspice circuit of the schematic's netlist, powered and driven by the simulation's sources. Throws one
 * error listing every part it cannot simulate: unreadable values, missing models, unknown kinds.
 */
export function spiceCircuit(netlist: Netlist, definitions: Record<string, ComponentDefinition> | undefined, simulation: Simulation): SpiceCircuit {
  const nets = [...new Set(netlist.components.flatMap((c) => c.pins.map((p) => p.net).filter(isRealNet)))]
  const nodes = nodeNames(nets)
  const problems: string[] = []
  const lines = ['* Manhattan schematic']
  const transistors: SpiceTransistor[] = []
  const usedModels = new Set<string>()

  for (const component of netlist.components) {
    const nodeOfPin = (number: string) => {
      const net = component.pins.find((p) => p.number === number)?.net ?? ''
      // A pin on no net still needs a node of its own; ngspice then says what is wrong with it.
      return isRealNet(net) ? nodes.get(net)! : `nc_${component.ref}_${number}`.toLowerCase()
    }
    try {
      const line = partLine(component, resolvedDefinition(component, definitions).definition, simulation, nodeOfPin)
      lines.push(line.text)
      if (line.model) usedModels.add(line.model)
      if (line.transistor) transistors.push(line.transistor)
    } catch (e) {
      problems.push((e as Error).message)
    }
  }

  const sources = simulation.sources.map((source, k) => {
    const node = nodes.get(source.net)
    if (node === undefined) problems.push(`Source on ${source.net}: no part is on that net`)
    else if (node === '0') problems.push(`Source on ${source.net}: that is ground`)
    else if (simulation.sources.findIndex((s) => s.net === source.net) < k) problems.push(`Source on ${source.net}: another source already drives that net`)
    else if (source.shape === 'square' && source.edgeSeconds >= 1 / source.hertz / 2) {
      problems.push(`Source on ${source.net}: its rise/fall time must be shorter than half its period`)
    }
    const element = `V_${node}`
    lines.push(`${element} ${node} 0 ${sourceVoltage(source)}`)
    return { ...source, element }
  })
  if (sources.length === 0) problems.push('Add a source: nothing powers the circuit')

  if (problems.length) throw new Error(problems.join('\n'))
  for (const model of usedModels) lines.push(simulation.models[model].trim())
  return { lines, nodes, transistors, sources }
}

interface PartLine {
  text: string
  /** The model it uses, by part value. */
  model?: string
  transistor?: SpiceTransistor
}

function partLine(
  component: NetComponent,
  definition: ComponentDefinition,
  simulation: Simulation,
  nodeOfPin: (number: string) => string,
): PartLine {
  const { ref, value } = component
  const prefix = refPrefix(ref)
  const passive = PASSIVES[prefix]
  if (passive && component.pins.length === 2) {
    const number = partValue(value)
    if (number === undefined) throw new Error(`${ref}: cannot read "${value}" as a value`)
    const [a, b] = component.pins
    return { text: `${elementName(passive, ref)} ${nodeOfPin(a.number)} ${nodeOfPin(b.number)} ${number}` }
  }

  if (!isTransistor(component) && !isDiode(component)) throw new Error(`${ref}: parts like this cannot be simulated yet`)
  const model = simulation.models[value]
  if (model === undefined) throw new Error(`${ref}: no SPICE model for "${value}"`)
  if (!definesModel(model, value)) throw new Error(`${ref}: the model for "${value}" does not start with ".model ${value}"`)
  const pinCalled = (name: string) => {
    const number = definition.pins.find((p) => p.name === name)?.number
    if (number === undefined) throw new Error(`${ref}: its definition "${definition.name}" names no pin ${name}`)
    return nodeOfPin(number)
  }
  if (isDiode(component)) return { text: `${elementName('D', ref)} ${pinCalled('A')} ${pinCalled('K')} ${value}`, model: value }
  const element = elementName('Q', ref)
  const [collector, base, emitter] = [pinCalled('C'), pinCalled('B'), pinCalled('E')]
  return {
    text: `${element} ${collector} ${base} ${emitter} ${value}`,
    model: value,
    transistor: { ref, element, collector, base, emitter },
  }
}

/** The netlist that asks ngspice for the DC operating point, with each transistor's base and collector current. */
export function operatingPointNetlist(circuit: SpiceCircuit): string {
  const currents = circuit.transistors.flatMap((t) => [`@${t.element}[ic]`, `@${t.element}[ib]`]).join(' ')
  return [...circuit.lines, `.save all ${currents}`.trim(), '.op', '.end'].join('\n')
}

/** Periods of the slowest wave a transient run shows, and the time steps per period of the fastest. */
const TRANSIENT_PERIODS = 5
const STEPS_PER_PERIOD = 200

/** The netlist that asks ngspice how the circuit responds to its wave sources over a few periods. */
export function transientNetlist(circuit: SpiceCircuit): string {
  const waves = waveSources(circuit.sources)
  if (waves.length === 0) throw new Error('Add a square or sine source to see how the circuit responds over time')
  const longest = 1 / waves[0].hertz
  const shortest = 1 / waves[waves.length - 1].hertz
  return [...circuit.lines, `.tran ${shortest / STEPS_PER_PERIOD} ${TRANSIENT_PERIODS * longest}`, '.end'].join('\n')
}

export interface Transient {
  /** Seconds since the sources started. */
  time: number[]
  /** Volts on each net at each time; ground nets are left out. */
  volts: Map<string, number[]>
}

/** The waveforms from ngspice's answer to transientNetlist. Throws when one it should hold is missing. */
export function readTransient(circuit: SpiceCircuit, vectors: SpiceVector[]): Transient {
  const byName = new Map(vectors.map((v) => [v.name.toLowerCase(), v.values]))
  const read = (name: string) => {
    const values = byName.get(name)
    if (!values || !values.every((v) => typeof v === 'number')) throw new Error(`ngspice gave no waveform for ${name}`)
    return values as number[]
  }
  const nets = [...circuit.nodes].filter(([, node]) => node !== '0')
  return { time: read('time'), volts: new Map(nets.map(([net, node]) => [net, read(`v(${node})`)])) }
}

/** One vector of ngspice's answer, e.g. "v(vout)" with one value per point. */
export interface SpiceVector {
  name: string
  values: unknown[]
}

export interface OperatingPoint {
  /** Volts on each net against ground. */
  volts: Map<string, number>
  /** What each DC source delivers, in amps; a wave source is at 0 V here. */
  dcSources: { net: string; volts: number; amps: number }[]
  transistors: { ref: string; vbe: number; vce: number; ic: number; ib: number }[]
}

/** The operating point from ngspice's answer to operatingPointNetlist. Throws when a value it should hold is missing. */
export function readOperatingPoint(circuit: SpiceCircuit, vectors: SpiceVector[]): OperatingPoint {
  const byName = new Map(vectors.map((v) => [v.name.toLowerCase(), v.values[0]]))
  const read = (name: string) => {
    const value = byName.get(name.toLowerCase())
    if (typeof value !== 'number') throw new Error(`ngspice gave no value for ${name}`)
    return value
  }
  const voltage = (node: string) => (node === '0' ? 0 : read(`v(${node})`))
  return {
    volts: new Map([...circuit.nodes].map(([net, node]) => [net, voltage(node)])),
    // ngspice counts current into the source's + terminal; what it delivers is the opposite.
    dcSources: circuit.sources.flatMap((s) => (s.shape === 'dc' ? [{ net: s.net, volts: s.volts, amps: -read(`i(${s.element})`) }] : [])),
    transistors: circuit.transistors.map((t) => ({
      ref: t.ref,
      vbe: voltage(t.base) - voltage(t.emitter),
      vce: voltage(t.collector) - voltage(t.emitter),
      ic: read(`i(@${t.element}[ic])`),
      ib: read(`i(@${t.element}[ib])`),
    })),
  }
}
