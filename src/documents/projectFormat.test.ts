import { describe, expect, it } from 'vitest'
import example from '../examples/Astable multivibrator.json?raw'
import { checkedProject, projectFileName, projectFromFile, projectNameOf, projectToFile, readSavedProject } from './projectFormat'

describe('projectFromFile', () => {
  it('drops the name older files stored: a project is called by its file name', () => {
    expect(JSON.parse(example).project.name).toBe('Astable multivibrator')
    expect(projectFromFile(example)).not.toHaveProperty('name')
    expect(JSON.parse(projectToFile(projectFromFile(example))).project).not.toHaveProperty('name')
  })
})

describe('checkedProject settings', () => {
  const stored = JSON.parse(example).project
  const settingsOf = (settings: object) => checkedProject({ ...stored, settings }).settings

  it('turns the strategy of files before v8 into a build style', () => {
    expect(stored.settings.strategy).toBe('knife')
    const knife = settingsOf({ ...stored.settings })
    expect(knife.buildStyle).toBe('knife')
    expect(knife).not.toHaveProperty('strategy')
    expect(settingsOf({ ...stored.settings, strategy: 'manhattan' }).buildStyle).toBe('manhattan')
    expect(settingsOf({ ...stored.settings, strategy: 'knife-cuts' }).buildStyle).toBe('knife')
  })

  it('keeps a build style as stored', () => {
    expect(settingsOf({ buildStyle: 'manhattan' }).buildStyle).toBe('manhattan')
  })

  it("drops the removed optimizer's settings", () => {
    expect(stored.settings).toMatchObject({ clearance: 3, maxLead: 10 })
    expect(settingsOf({ buildStyle: 'manhattan', placement: 'schematic', clearance: 3, maxLead: 10 })).toEqual({
      snap: 0.5,
      isolation: 0.4,
      buildStyle: 'manhattan',
    })
  })

  it('refuses an unknown build style', () => {
    expect(() => settingsOf({ strategy: 'teleport' })).toThrow('Unknown build style "teleport"')
    expect(() => settingsOf({ buildStyle: 'glue' })).toThrow('Unknown build style "glue"')
  })

  it('writes only the snap, isolation and build style', () => {
    const saved = JSON.parse(projectToFile(projectFromFile(example)))
    expect(saved.version).toBe(8)
    expect(Object.keys(saved.project.settings).sort()).toEqual(['buildStyle', 'isolation', 'snap'])
  })
})

describe('readSavedProject', () => {
  it('gives a project as this version writes it, and keeps text that is no project as it is', () => {
    expect(readSavedProject(example).content).toBe(projectToFile(projectFromFile(example)))
    expect(readSavedProject('hello')).toEqual({ project: null, content: 'hello' })
  })
})

describe('project file names', () => {
  it('turn a name into a file name and back', () => {
    expect(projectFileName('amp')).toBe('amp.json')
    expect(projectNameOf(projectFileName('amp'))).toBe('amp')
    expect(projectNameOf('amp.manhattan.json')).toBe('amp')
  })
})
