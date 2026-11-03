import { describe, expect, it } from 'vitest'
import { entryNamed, projectName, type ExplorerEntry } from './explorerStorage'

const file = (fileName: string): ExplorerEntry => ({ name: projectName(fileName), fileName, location: { kind: 'drive', fileId: fileName, version: '1' } })
const folder = (name: string): ExplorerEntry => ({ name, fileName: name, folder: { kind: 'drive', id: name } })

describe('projectName', () => {
  it('drops the project extension', () => {
    expect(projectName('amp.manhattan.json')).toBe('amp')
    expect(projectName('old.json')).toBe('old')
  })
})

describe('entryNamed', () => {
  const entries = [file('Amp.manhattan.json'), file('psu.json'), folder('Designs')]
  it('finds a project with the same name, whatever its case or extension', () => {
    expect(entryNamed(entries, 'amp', false)?.fileName).toBe('Amp.manhattan.json')
    expect(entryNamed(entries, 'PSU', false)?.fileName).toBe('psu.json')
    expect(entryNamed(entries, 'other', false)).toBeUndefined()
  })
  it('finds a folder only by its own name', () => {
    expect(entryNamed(entries, 'designs', true)?.fileName).toBe('Designs')
    expect(entryNamed(entries, 'amp', true)).toBeUndefined()
  })
})
