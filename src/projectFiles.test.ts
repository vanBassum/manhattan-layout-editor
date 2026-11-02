import { describe, expect, it } from 'vitest'
import example from './examples/multivibrator.manhattan.json?raw'
import { compareWithFile, saveProjectFile } from './projectFiles'
import { projectFromFile, projectToFile, type ProjectFile } from './projectStore'

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
const linked = (file: ReturnType<typeof fakeFile>, dirty = false): ProjectFile => ({ handle: asHandle(file), savedContent: saved, dirty, checked: true })
const changedElsewhere = projectToFile({ ...project, name: 'Changed elsewhere' })

describe('saveProjectFile', () => {
  it('writes to the linked file without asking when it did not change on disk', async () => {
    const file = fakeFile(saved)
    const renamed = { ...project, name: 'Renamed' }
    const handle = await saveProjectFile(renamed, linked(file), false, async () => {
      throw new Error('should not ask')
    })
    expect(handle).toBe(asHandle(file))
    expect(file.written).toEqual([projectToFile(renamed)])
  })

  it('asks before overwriting a file that changed on disk, and writes nothing when refused', async () => {
    const file = fakeFile(changedElsewhere)
    const asked: string[] = []
    const handle = await saveProjectFile(project, linked(file), false, async (name) => {
      asked.push(name)
      return false
    })
    expect(asked).toEqual(['amp.manhattan.json'])
    expect(handle).toBeNull()
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
