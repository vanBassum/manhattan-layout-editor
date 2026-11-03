import { resolvedDefinition } from '../model/definitions'
import { refPrefix } from '../model/footprintTemplates'
import { isGroundNet, isRealNet } from '../model/netlist'
import type { ComponentDefinition, NetComponent, Netlist, Simulation } from '../model/types'

// Turns the schematic into an ngspice netlist and reads ngspice's answers back onto nets and parts.

const SCALES: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 }

/**
 * A part value as a number: "12k", "4k7", "2.2uF", "80Ω", "100n", "2R2". M is mega, as written on
 * parts, where SPICE would read milli; that is why values go to ngspice as plain numbers.
 * Undefined for text that is no value.
 */
export function partValue(text: string): number | undefined {
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*([pnuµmkKMGR]?)(\d*)\s*(Ω|ohms?|F|H)?$/)
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
  /** The voltage source element of each supply. */
  supplies: { net: string; volts: number; element: string }[]
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
 * The ngspice circuit of the schematic's netlist, powered by the simulation's supplies. Throws one
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

  const supplies = simulation.supplies.map((supply) => {
    const node = nodes.get(supply.net)
    if (node === undefined) problems.push(`Supply ${supply.net}: no part is on that net`)
    else if (node === '0') problems.push(`Supply ${supply.net}: that is ground`)
    const element = `V_${node}`
    lines.push(`${element} ${node} 0 DC ${supply.volts}`)
    return { ...supply, element }
  })
  if (supplies.length === 0) problems.push('Add a supply: nothing powers the circuit')

  if (problems.length) throw new Error(problems.join('\n'))
  for (const model of usedModels) lines.push(simulation.models[model].trim())
  return { lines, nodes, transistors, supplies }
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

/** One vector of ngspice's answer, e.g. "v(vout)" with one value per point. */
export interface SpiceVector {
  name: string
  values: unknown[]
}

export interface OperatingPoint {
  /** Volts on each net against ground. */
  volts: Map<string, number>
  /** What each supply delivers, in amps. */
  supplies: { net: string; volts: number; amps: number }[]
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
    // ngspice counts current into the source's + terminal; a supply delivers the opposite.
    supplies: circuit.supplies.map(({ net, volts, element }) => ({ net, volts, amps: -read(`i(${element})`) })),
    transistors: circuit.transistors.map((t) => ({
      ref: t.ref,
      vbe: voltage(t.base) - voltage(t.emitter),
      vce: voltage(t.collector) - voltage(t.emitter),
      ic: read(`i(@${t.element}[ic])`),
      ib: read(`i(@${t.element}[ib])`),
    })),
  }
}
