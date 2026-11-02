// Runs an AI agent's command, as forwarded by the MCP server (mcp/server.mjs) through agentBridge,
// on one project tab. Every tool of the server except list_projects is a command here.

import {
  addComponent,
  applyBatch,
  describeProject,
  findProblems,
  layoutBounds,
  moveComponent,
  moveIsland,
  resetLeads,
  setFootprint,
  setIsland,
  setLeadEnd,
} from './agentCommands'
import { buildNetlist, builtProject, checkedDefinition, withAssignedDefinition } from './definitions'
import { chooseResistors, keepFootprintChoices } from './layout'
import { withValues } from './netlist'
import { findStrategy } from './optimize'
import {
  agentPlacements,
  labelsFromAgent,
  pinEnds,
  pinsWithOtherNet,
  projectSchematic,
  projectSchematicNets,
  wiresFromPolylines,
  withPlacementChanges,
  withSchematicNets,
  type FullSchematic,
} from './schematic'
import type { BuiltProject, Layout, Netlist, Project, Rect } from './types'
import { snapshotOf, type Snapshot } from './undoHistory'

type Args = Record<string, unknown>

/** What every edit returns: the problems left in the PCB. */
const projectProblems = (project: Project) => ({ problems: findProblems(builtProject(project)) })

/** The tab a command works on, and what the editor does for it. */
export interface AgentTab {
  /** As stored: without the footprint choices applied. */
  project: Project
  /** Applies an undoable change; returns the changed project. */
  change: (changes: Partial<Snapshot>) => Project
  /** Undo or redo; returns the project after it. */
  step: (direction: 'undo' | 'redo') => Project
  /** PNG (base64) of the layout as drawn, within `bounds`. */
  screenshot: (project: BuiltProject, bounds: Rect) => Promise<string>
}

/** The tab a command is for: its "project" argument, a tab id or name, else the shown tab. */
export function agentTargetId(tabs: { id: string; name: string }[], shownId: string, wanted: unknown): string {
  if (wanted === undefined || wanted === '') return shownId
  const name = String(wanted)
  const byId = tabs.find((t) => t.id === name)
  if (byId) return byId.id
  const byName = tabs.filter((t) => t.name.toLowerCase() === name.toLowerCase())
  if (byName.length === 1) return byName[0].id
  const known = tabs.map((t) => `${t.name} (${t.id})`).join(', ')
  throw new Error(`${byName.length > 1 ? 'Several' : 'No'} projects named "${name}"; use the id. Open: ${known}`)
}

/** What an agent needs to draw wires: every pin end with its schematic net, the wires and labels, shorts, and what the PCB does not have yet. */
function describeSchematic(project: Project) {
  const schematic = projectSchematic(project)
  const { netlist, conflicts } = projectSchematicNets(project)
  const built = buildNetlist(netlist, project.layout.placements, project.definitions)
  return {
    units: 'mm; x to the right, y down; grid 2.54',
    parts: built.components.map((component, i) => ({
      value: component.value,
      ...schematic.placements[i],
      pins: pinEnds(component, schematic.placements[i]).map((end, k) => ({
        pin: component.pins[k].number,
        net: component.pins[k].net,
        x: end.x,
        y: end.y,
      })),
    })),
    wires: schematic.wires,
    labels: schematic.labels,
    shorts: conflicts.map((c) => c.names),
    pinsNotInPcb: pinsWithOtherNet(project.netlist, netlist),
  }
}

/**
 * A command that changes only the layout. `edit` gets the project as built and the netlist as
 * imported; the agent gets the problems after the change.
 */
const layoutEdit =
  (edit: (current: BuiltProject, args: Args, imported: Netlist) => Layout) =>
  (tab: AgentTab, args: Args) => {
    const layout = edit(builtProject(tab.project), args, tab.project.netlist)
    return projectProblems(tab.change({ layout }))
  }

/** The schematic with one part of it replaced, as an undoable change; the agent gets the result as get_schematic does. */
const schematicEdit =
  (edit: (project: Project, args: Args) => Partial<FullSchematic>) =>
  (tab: AgentTab, args: Args) => {
    const schematic = { ...projectSchematic(tab.project), ...edit(tab.project, args) }
    return describeSchematic(tab.change({ schematic }))
  }

const COMMANDS: Record<string, (tab: AgentTab, args: Args) => unknown> = {
  get_layout: (tab) => describeProject(builtProject(tab.project)),
  screenshot: (tab) => {
    const current = builtProject(tab.project)
    const bounds = layoutBounds(current)
    if (!bounds) throw new Error('Nothing to draw')
    return tab.screenshot(current, bounds).then((png) => ({ png }))
  },
  undo: (tab) => projectProblems(tab.step('undo')),
  redo: (tab) => projectProblems(tab.step('redo')),

  move_component: layoutEdit(moveComponent),
  set_lead_end: layoutEdit(setLeadEnd),
  reset_leads: layoutEdit(resetLeads),
  set_island: layoutEdit(setIsland),
  move_island: layoutEdit(moveIsland),
  batch: layoutEdit(applyBatch),
  run_optimizer: layoutEdit((current, args) => {
    const optimized = findStrategy(String(args.strategy)).run(current.netlist, current.settings)
    return keepFootprintChoices(optimized, current.layout)
  }),
  set_resistor_footprint: layoutEdit((current, args, imported) => {
    if (args.footprint !== 'through-hole' && args.footprint !== '1206') throw new Error('"footprint" must be "through-hole" or "1206"')
    return chooseResistors(imported, current.layout, args.footprint)
  }),
  set_footprint: layoutEdit((current, args, imported) => setFootprint(current, imported, args)),

  get_schematic: (tab) => describeSchematic(tab.project),
  set_schematic: schematicEdit((project, args) =>
    withPlacementChanges(projectSchematic(project), builtProject(project).netlist, agentPlacements(project.netlist, args.placements)),
  ),
  set_wires: schematicEdit((_, args) => ({ wires: wiresFromPolylines(args.wires) })),
  set_labels: schematicEdit((_, args) => ({ labels: labelsFromAgent(args.labels) })),
  update_pcb: (tab) => projectProblems(tab.change(snapshotOf(withSchematicNets(tab.project)))),

  get_definitions: ({ project }) => ({
    definitions: project.definitions ?? {},
    parts: project.netlist.components.map((c) => ({ ref: c.ref, value: c.value, definition: c.definition, footprint: c.footprint })),
  }),
  set_definition: (tab, args) => {
    const id = String(args.id ?? '')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('"id" must be lowercase letters, digits and dashes, e.g. "lm1875"')
    const definitions = { ...tab.project.definitions, [id]: checkedDefinition(args.definition) }
    tab.change({ definitions })
    return { id, definitions: Object.keys(definitions) }
  },
  assign_definition: (tab, args) => {
    const netlist = withAssignedDefinition(tab.project.netlist, tab.project.definitions, args.refs, args.definition)
    tab.change({ netlist })
    return { parts: netlist.components.map((c) => ({ ref: c.ref, definition: c.definition })) }
  },
  set_values: (tab, args) => {
    const netlist = withValues(tab.project.netlist, args.values)
    tab.change({ netlist })
    return { components: netlist.components.map((c) => ({ ref: c.ref, value: c.value })) }
  },
  add_component: (tab, args) => {
    const updated = tab.change(addComponent(tab.project, args))
    const part = describeSchematic(updated).parts.find((p) => p.ref === args.ref)
    return { part, ...projectProblems(updated) }
  },
}

/** The commands this module runs; the MCP server offers the same ones (see agentDispatch.test.ts). */
export const AGENT_COMMANDS = Object.keys(COMMANDS)

export function runAgentCommand(command: string, args: Args, tab: AgentTab): unknown {
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`Unknown command "${command}"`)
  return COMMANDS[command](tab, args)
}
