import { describe, expect, it } from 'vitest'
import server from '../mcp/server.mjs?raw'
import { AGENT_COMMANDS, agentTargetId, runAgentCommand, type AgentTab } from './agentDispatch'
import example from './examples/multivibrator.manhattan.json?raw'
import { emptyProject, projectFromFile } from './projectStore'

describe('agent commands', () => {
  it('are the tools the MCP server offers, except list_projects which App answers itself', () => {
    const tools = [...server.matchAll(/(?:forward|registerTool)\(\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(tools.filter((t) => t !== 'list_projects').sort()).toEqual([...AGENT_COMMANDS].sort())
  })

  it('applies an edit through the tab and reports the problems after it', () => {
    let project = projectFromFile(example)
    const tab: AgentTab = { project, change: (changes) => (project = { ...project, ...changes }), step: () => project, screenshot: async () => '' }
    const result = runAgentCommand('move_component', { ref: 'R1', x: 10, y: 20 }, tab)
    expect(project.layout.placements.find((p) => p.ref === 'R1')).toMatchObject({ x: 10, y: 20 })
    expect(result).toHaveProperty('problems.openPins')
  })

  it('refuses a command it does not know, also one named like an object property', () => {
    const tab = { project: emptyProject() } as AgentTab
    expect(() => runAgentCommand('explode', {}, tab)).toThrow('Unknown command "explode"')
    expect(() => runAgentCommand('toString', {}, tab)).toThrow('Unknown command')
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
