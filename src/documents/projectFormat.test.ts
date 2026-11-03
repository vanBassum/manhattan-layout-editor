import { describe, expect, it } from 'vitest'
import example from '../examples/Astable multivibrator.manhattan.json?raw'
import { projectFileName, projectFromFile, projectNameOf, projectToFile, readSavedProject } from './projectFormat'

describe('projectFromFile', () => {
  it('drops the name older files stored: a project is called by its file name', () => {
    expect(JSON.parse(example).project.name).toBe('Astable multivibrator')
    expect(projectFromFile(example)).not.toHaveProperty('name')
    expect(JSON.parse(projectToFile(projectFromFile(example))).project).not.toHaveProperty('name')
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
    expect(projectFileName('amp')).toBe('amp.manhattan.json')
    expect(projectNameOf(projectFileName('amp'))).toBe('amp')
    expect(projectNameOf('amp.json')).toBe('amp')
  })
})
