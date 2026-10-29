import type { NetComponent, Netlist } from './types'

/**
 * Accepts:
 * - EasyEDA netlist JSON (.enet): { "<id>": { props: { designator, value }, pins: { "1": "GND" } } }
 *   (also wrapped in a top-level "components" object, as EasyEDA Pro does)
 * - Telesis netlist (.tel, EasyEDA export: "$PACKAGES ... $NETS ... $END")
 * - KiCad netlist (.net, s-expression "(export ...")
 * - Protel/Altium netlist (EasyEDA can export this too)
 */
export function parseNetlist(text: string): Netlist {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return parseEasyEdaJson(JSON.parse(trimmed))
  if (trimmed.startsWith('$PACKAGES') || trimmed.includes('$NETS')) return parseTelesis(trimmed)
  if (trimmed.startsWith('(export')) return parseKicad(trimmed)
  if (trimmed.startsWith('[') || trimmed.startsWith('(')) return parseProtel(trimmed)
  throw new Error('Unrecognized netlist format. Expected EasyEDA JSON, KiCad .net or Protel netlist.')
}

/** KiCad gives every unconnected pin its own "unconnected-..." net; those get no island. */
export function isRealNet(net: string): boolean {
  return net !== '' && !net.startsWith('unconnected-')
}

export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

function buildNetlist(components: NetComponent[]): Netlist {
  if (components.length === 0) throw new Error('Netlist contains no components.')
  for (const c of components) c.pins.sort((a, b) => naturalCompare(a.number, b.number))
  components.sort((a, b) => naturalCompare(a.ref, b.ref))
  const nets = new Set<string>()
  for (const c of components) for (const p of c.pins) if (isRealNet(p.net)) nets.add(p.net)
  return { components, nets: [...nets].sort(naturalCompare) }
}

// ---------- EasyEDA JSON ----------

type JsonObject = Record<string, unknown>

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null

function lowerCaseKeys(obj: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]))
}

function pinNet(value: unknown): string {
  if (typeof value === 'string') return value
  if (isObject(value)) return String(value.net ?? value.netName ?? value.name ?? '')
  return ''
}

function parseEasyEdaJson(data: unknown): Netlist {
  if (!isObject(data)) throw new Error('EasyEDA netlist must be a JSON object.')
  const entries = isObject(data.components) ? data.components : data
  const components: NetComponent[] = []
  for (const [id, entry] of Object.entries(entries)) {
    if (!isObject(entry) || !isObject(entry.pins)) continue
    const props = lowerCaseKeys(isObject(entry.props) ? entry.props : {})
    components.push({
      ref: String(props.designator ?? id),
      value: String(props.value ?? props.name ?? ''),
      footprint: String(props.footprint ?? props.package ?? ''),
      pins: Object.entries(entry.pins).map(([number, net]) => ({ number, net: pinNet(net) })),
    })
  }
  return buildNetlist(components)
}

// ---------- Telesis ----------

/** Joins continuation lines (a trailing ',' means the statement continues on the next line). */
function telesisStatements(lines: string[]): string[] {
  const statements: string[] = []
  let pending = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line === ',') continue
    if (line.endsWith(',')) {
      pending += line.slice(0, -1) + ' '
    } else {
      statements.push(pending + line)
      pending = ''
    }
  }
  return statements
}

const unquote = (s: string) => s.trim().replace(/^'(.*)'$/, '$1')

function parseTelesis(text: string): Netlist {
  const components = new Map<string, NetComponent>()
  const getComponent = (ref: string) => {
    let component = components.get(ref)
    if (!component) {
      component = { ref, value: '', footprint: '', pins: [] }
      components.set(ref, component)
    }
    return component
  }
  const sections = new Map<string, string[]>()
  let section = ''
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('$')) {
      section = line.trim()
      sections.set(section, [])
    } else {
      sections.get(section)?.push(line)
    }
  }
  // footprint ! footprint ! value ; REF REF ...
  for (const statement of telesisStatements(sections.get('$PACKAGES') ?? [])) {
    const [left, refs = ''] = statement.split(';')
    const [footprint, , rawValue = ''] = left.split('!').map(unquote)
    const value = rawValue === '{Value}' ? '' : rawValue
    for (const ref of refs.trim().split(/\s+/).filter(Boolean)) {
      Object.assign(getComponent(ref), { footprint, value })
    }
  }
  // net ; REF.PIN REF.PIN ...
  for (const statement of telesisStatements(sections.get('$NETS') ?? [])) {
    const [name, nodes = ''] = statement.split(';')
    const net = unquote(name)
    for (const node of nodes.trim().split(/\s+/).filter(Boolean)) {
      const dot = node.lastIndexOf('.')
      if (dot <= 0) continue
      getComponent(node.slice(0, dot)).pins.push({ number: node.slice(dot + 1), net })
    }
  }
  return buildNetlist([...components.values()])
}

// ---------- KiCad ----------

type SExpr = string | SExpr[]

function parseSExpr(text: string): SExpr {
  let i = 0
  const skipWhitespace = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const parse = (): SExpr => {
    skipWhitespace()
    if (text[i] === '(') {
      i++
      const list: SExpr[] = []
      for (;;) {
        skipWhitespace()
        if (i >= text.length) throw new Error('Unbalanced parentheses in KiCad netlist.')
        if (text[i] === ')') {
          i++
          return list
        }
        list.push(parse())
      }
    }
    let atom = ''
    if (text[i] === '"') {
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++
        atom += text[i++]
      }
      i++
      return atom
    }
    while (i < text.length && !/[\s()]/.test(text[i])) atom += text[i++]
    return atom
  }
  return parse()
}

function childLists(list: SExpr, name: string): SExpr[][] {
  if (!Array.isArray(list)) return []
  return list.filter((c): c is SExpr[] => Array.isArray(c) && c[0] === name)
}

function attribute(list: SExpr[], name: string): string {
  const value = childLists(list, name)[0]?.[1]
  return typeof value === 'string' ? value : ''
}

function parseKicad(text: string): Netlist {
  const root = parseSExpr(text)
  const components = new Map<string, NetComponent>()
  for (const section of childLists(root, 'components')) {
    for (const comp of childLists(section, 'comp')) {
      const ref = attribute(comp, 'ref')
      components.set(ref, { ref, value: attribute(comp, 'value'), footprint: attribute(comp, 'footprint'), pins: [] })
    }
  }
  for (const section of childLists(root, 'nets')) {
    for (const net of childLists(section, 'net')) {
      const name = attribute(net, 'name')
      for (const node of childLists(net, 'node')) {
        const ref = attribute(node, 'ref')
        let component = components.get(ref)
        if (!component) {
          component = { ref, value: '', footprint: '', pins: [] }
          components.set(ref, component)
        }
        component.pins.push({ number: attribute(node, 'pin'), net: name })
      }
    }
  }
  return buildNetlist([...components.values()])
}

// ---------- Protel ----------

function blockLines(block: string): string[] {
  return block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
}

function parseProtel(text: string): Netlist {
  const components = new Map<string, NetComponent>()
  const getComponent = (ref: string) => {
    let component = components.get(ref)
    if (!component) {
      component = { ref, value: '', footprint: '', pins: [] }
      components.set(ref, component)
    }
    return component
  }
  // [ ref / footprint / value ]  and  ( net / REF-PIN ... )
  for (const match of text.matchAll(/\[([^\]]*)\]|\(([^)]*)\)/g)) {
    if (match[1] !== undefined) {
      const [ref, footprint = '', value = ''] = blockLines(match[1])
      if (ref) Object.assign(getComponent(ref), { footprint, value })
    } else {
      const [net, ...nodes] = blockLines(match[2])
      for (const node of nodes) {
        const dash = node.lastIndexOf('-')
        if (dash <= 0) continue
        getComponent(node.slice(0, dash)).pins.push({ number: node.slice(dash + 1), net })
      }
    }
  }
  return buildNetlist([...components.values()])
}
