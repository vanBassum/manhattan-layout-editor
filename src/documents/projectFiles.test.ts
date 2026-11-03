import { describe, expect, it } from 'vitest'
import example from '../examples/Astable multivibrator.manhattan.json?raw'
import { compareSaved, compareWithFile, saveToFile } from './projectFiles'
import { projectFromFile, projectToFile, readSavedProject } from './projectFormat'
import type { ProjectFile } from './projectStore'

/** A file with permission already granted; `written` collects what the editor writes to it. */
function fakeFile(content: string) {
  const file = {
    name: 'amp.manhattan.json',
    content,
    written: [] as string[],
    getFile: async () => ({ text: async () => file.content }),
    queryPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (text: string) => void file.written.push(text),
      close: async () => {},
    }),
  }
  return file
}

const asHandle = (file: ReturnType<typeof fakeFile>) => file as unknown as FileSystemFileHandle
const project = projectFromFile(example)
const saved = projectToFile(project)
const linked = (file: ReturnType<typeof fakeFile>, dirty = false): ProjectFile => ({ location: { kind: 'local', handle: asHandle(file) }, savedContent: saved, dirty, checked: true })
const changedElsewhere = projectToFile({ ...project, settings: { ...project.settings, snap: 1 } })

describe('saveToFile', () => {
  it('writes to the linked file without asking when it did not change on disk', async () => {
    const file = fakeFile(saved)
    const changed = { ...project, settings: { ...project.settings, snap: 1 } }
    const written = await saveToFile(changed, asHandle(file), saved, async () => {
      throw new Error('should not ask')
    })
    expect(written).toBe(true)
    expect(file.written).toEqual([projectToFile(changed)])
  })

  it('asks before overwriting a file that changed on disk, and writes nothing when refused', async () => {
    const file = fakeFile(changedElsewhere)
    const asked: string[] = []
    const written = await saveToFile(project, asHandle(file), saved, async (name) => {
      asked.push(name)
      return false
    })
    expect(asked).toEqual(['amp.manhattan.json'])
    expect(written).toBe(false)
    expect(file.written).toEqual([])
  })

  it('refuses to overwrite a file it cannot read, without asking', async () => {
    const file = { ...fakeFile(saved), getFile: async () => Promise.reject(new Error('the file is locked')) }
    const save = saveToFile(project, asHandle(file), saved, async () => {
      throw new Error('should not ask')
    })
    await expect(save).rejects.toThrow('the file is locked')
    expect(file.written).toEqual([])
  })
})

describe('compareWithFile', () => {
  it('tells an unchanged file, a newer one, and changes on both sides apart', async () => {
    expect(await compareWithFile(asHandle(fakeFile(saved)), linked(fakeFile(saved)))).toMatchObject({ kind: 'unchanged' })
    const elsewhere = fakeFile(changedElsewhere)
    expect(await compareWithFile(asHandle(elsewhere), linked(elsewhere))).toMatchObject({ kind: 'newer' })
    expect(await compareWithFile(asHandle(elsewhere), linked(elsewhere, true))).toMatchObject({ kind: 'conflict' })
  })

  it('refuses a file that is no project anymore', async () => {
    const file = fakeFile('hello')
    await expect(compareWithFile(asHandle(file), linked(file))).rejects.toThrow('not a Manhattan project')
  })
})

describe('compareSaved', () => {
  it('finds no change between the same project written by an older and a newer version', () => {
    const olderSaved: ProjectFile = { savedContent: example, dirty: false, checked: false }
    expect(compareSaved(projectToFile(projectFromFile(example)), { ...olderSaved, savedContent: readSavedProject(example).content })).toMatchObject({ kind: 'unchanged' })
  })
})
