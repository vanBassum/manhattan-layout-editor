import { beforeEach, describe, expect, it, vi } from 'vitest'
import example from '../examples/Astable multivibrator.manhattan.json?raw'
import { compareWithDrive, saveDriveDocument, type DriveLocation } from './driveDocuments'
import { fileVersion, readFile, writeFile } from './googleDrive'
import { projectFromFile, projectToFile } from './projectFormat'
import type { ProjectFile } from './projectStore'

vi.mock('./googleDrive', () => ({
  fileVersion: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileInfo: vi.fn(),
  findFile: vi.fn(),
}))

const project = projectFromFile(example)
const saved = projectToFile(project)
const changed = { ...project, settings: { ...project.settings, snap: 1 } }
const location: DriveLocation = { kind: 'drive', fileId: 'doc', version: '3' }
const neverAsked = async () => {
  throw new Error('should not ask')
}

/** The document in Drive is at `version` and holds `text`. */
function driveHolds(version: string, text: string) {
  vi.mocked(fileVersion).mockResolvedValue(version)
  vi.mocked(readFile).mockResolvedValue(text)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(writeFile).mockResolvedValue({ id: 'doc', version: '4', name: 'amp.manhattan.json', mimeType: 'application/json', modifiedTime: '' })
})

describe('saveDriveDocument', () => {
  it('writes without asking when the document is still at the version saved here', async () => {
    driveHolds('3', saved)
    expect(await saveDriveDocument(changed, 'amp', location, saved, neverAsked)).toEqual({ kind: 'drive', fileId: 'doc', version: '4' })
    expect(writeFile).toHaveBeenCalledWith(projectToFile(changed), { id: 'doc' })
  })

  it('writes without asking when only the version changed, not the project', async () => {
    // An older version of the editor wrote the same project.
    driveHolds('5', example)
    expect(await saveDriveDocument(changed, 'amp', location, saved, neverAsked)).toMatchObject({ version: '4' })
  })

  it('asks before overwriting a document changed elsewhere, and writes nothing when refused', async () => {
    driveHolds('5', projectToFile(changed))
    const asked: string[] = []
    const result = await saveDriveDocument(project, 'amp', location, saved, async (name) => {
      asked.push(name)
      return false
    })
    expect(asked).toEqual(['amp'])
    expect(result).toBeNull()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('overwrites a document changed elsewhere when confirmed', async () => {
    driveHolds('5', projectToFile(changed))
    expect(await saveDriveDocument(project, 'amp', location, saved, async () => true)).toMatchObject({ version: '4' })
    expect(writeFile).toHaveBeenCalledWith(saved, { id: 'doc' })
  })
})

describe('compareWithDrive', () => {
  const file = (dirty: boolean): ProjectFile => ({ location, savedContent: saved, dirty, checked: false })

  it('does not read a document still at the version saved here', async () => {
    driveHolds('3', 'unread')
    expect(await compareWithDrive(location, file(false))).toEqual({ comparison: { kind: 'unchanged', content: saved }, location })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reads a document at a newer version, and returns that version', async () => {
    driveHolds('5', projectToFile(changed))
    const newer = await compareWithDrive(location, file(false))
    expect(newer.comparison).toMatchObject({ kind: 'newer', content: projectToFile(changed) })
    expect(newer.location).toEqual({ ...location, version: '5' })
    expect((await compareWithDrive(location, file(true))).comparison).toMatchObject({ kind: 'conflict' })
  })

  it('refuses a document that is no project anymore', async () => {
    driveHolds('5', 'hello')
    await expect(compareWithDrive(location, file(false))).rejects.toThrow('not a Manhattan project')
  })
})
