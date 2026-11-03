import { describe, expect, it } from 'vitest'
import server from '../../mcp/server.mjs?raw'
import { AGENT_COMMANDS, agentTargetId, runAgentCommand, type AgentEditor, type AgentTab } from './agentDispatch'
import example from '../examples/Astable multivibrator.manhattan.json?raw'
import { STRATEGIES } from '../optimize'
import { emptyProject, projectFromFile } from '../documents/projectFormat'

/** An editor with `tab` as its only, shown tab. */
const editorWith = (tab: AgentTab): AgentEditor => ({ tabs: [{ id: 't1', name: 'Test' }], shownId: 't1', tab: () => tab })

describe('agent commands', () => {
  it('are the tools the MCP server offers', () => {
    const tools = [...server.matchAll(/(?:forward|registerTool)\(\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(tools.sort()).toEqual([...AGENT_COMMANDS].sort())
  })

  it('list the open tabs and which one is shown', () => {
    const editor: AgentEditor = {
      tabs: [
        { id: 'a1', name: 'Amp' },
        { id: 'b2', name: 'Buffer' },
      ],
      shownId: 'b2',
      tab: () => {
        throw new Error('list_projects works on no tab')
      },
    }
    expect(runAgentCommand('list_projects', {}, editor)).toEqual({
      projects: [
        { id: 'a1', name: 'Amp', shown: false },
        { id: 'b2', name: 'Buffer', shown: true },
      ],
    })
  })

  it('work on the tab their "project" argument names', () => {
    const tabs: Record<string, AgentTab> = { a1: { project: projectFromFile(example) } as AgentTab, b2: { project: emptyProject() } as AgentTab }
    const editor: AgentEditor = { tabs: [{ id: 'a1', name: 'Amp' }, { id: 'b2', name: 'Buffer' }], shownId: 'b2', tab: (id) => tabs[id] }
    const parts = (result: unknown) => (result as { parts: unknown[] }).parts.length
    expect(parts(runAgentCommand('get_definitions', { project: 'amp' }, editor))).toBeGreaterThan(0)
    expect(parts(runAgentCommand('get_definitions', {}, editor))).toBe(0)
  })

  it('applies an edit through the tab and reports the problems after it', () => {
    let project = projectFromFile(example)
    const tab: AgentTab = { project, change: (changes) => (project = { ...project, ...changes }), step: () => project, screenshot: async () => '' }
    const result = runAgentCommand('move_component', { ref: 'R1', x: 10, y: 20 }, editorWith(tab))
    expect(project.layout.placements.find((p) => p.ref === 'R1')).toMatchObject({ x: 10, y: 20 })
    expect(result).toHaveProperty('problems.openPins')
  })

  it('offer exactly the optimizer strategies the editor has', () => {
    const offered = /strategy: z\.enum\(\[([^\]]*)\]\)/.exec(server)![1].match(/[a-z-]+/g)
    expect(offered).toEqual(STRATEGIES.map((s) => s.id))
  })

  it('refuse an unknown strategy instead of running another one', () => {
    let project = projectFromFile(example)
    const tab: AgentTab = { project, change: (changes) => (project = { ...project, ...changes }), step: () => project, screenshot: async () => '' }
    expect(() => runAgentCommand('run_optimizer', { strategy: 'teleport' }, editorWith(tab))).toThrow('Unknown strategy "teleport"')
    expect(() => runAgentCommand('run_optimizer', {}, editorWith(tab))).toThrow('"strategy" must be a non-empty string')
  })

  it('run every strategy on the example', () => {
    for (const { id } of STRATEGIES) {
      let project = projectFromFile(example)
      const tab: AgentTab = { project, change: (changes) => (project = { ...project, ...changes }), step: () => project, screenshot: async () => '' }
      expect(() => runAgentCommand('run_optimizer', { strategy: id }, editorWith(tab))).not.toThrow()
    }
  })

  it('refuse a definition change that takes away pins a part still uses', () => {
    let project = projectFromFile(example)
    const tab: AgentTab = { project, change: (changes) => (project = { ...project, ...changes }), step: () => project, screenshot: async () => '' }
    const part = project.netlist.components.find((c) => c.ref === 'R1')!
    const used = project.definitions![part.definition!]
    const onePin = { ...used, pins: [used.pins[0]], symbol: { ...used.symbol, pins: [used.symbol.pins[0]] }, footprints: {} }
    expect(() => runAgentCommand('set_definition', { id: part.definition, definition: onePin }, editorWith(tab))).toThrow(
      `definition "${part.definition}" lacks some of its pins`,
    )
    expect(project.definitions![part.definition!]).toBe(used)
  })

  it('refuses a command it does not know, also one named like an object property', () => {
    const tab = { project: emptyProject() } as AgentTab
    expect(() => runAgentCommand('explode', {}, editorWith(tab))).toThrow('Unknown command "explode"')
    expect(() => runAgentCommand('toString', {}, editorWith(tab))).toThrow('Unknown command')
  })
})

describe('agentTargetId', () => {
  const tabs = [
    { id: 'a1', name: 'Amp' },
    { id: 'b2', name: 'Buffer' },
    { id: 'c3', name: 'buffer' },
  ]

  it('is the shown tab without a project argument', () => {
    expect(agentTargetId(tabs, 'b2', undefined)).toBe('b2')
  })

  it('finds a tab by id or by a unique name, ignoring case', () => {
    expect(agentTargetId(tabs, 'b2', 'c3')).toBe('c3')
    expect(agentTargetId(tabs, 'b2', 'amp')).toBe('a1')
  })

  it('refuses a name that several tabs share', () => {
    expect(() => agentTargetId(tabs, 'a1', 'BUFFER')).toThrow('Several projects named')
  })
})
