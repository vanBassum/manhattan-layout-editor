import { beforeEach, describe, expect, it, vi } from 'vitest'
import example from '../examples/Astable multivibrator.json?raw'
import { compareWithDrive, overwriteDriveDocument, saveDriveDocument, type DriveLocation } from './driveDocuments'
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

/** The document in Drive is at `version` and holds `text`. */
function driveHolds(version: string, text: string) {
  vi.mocked(fileVersion).mockResolvedValue(version)
  vi.mocked(readFile).mockResolvedValue(text)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(writeFile).mockResolvedValue({ id: 'doc', version: '4', name: 'amp.json', mimeType: 'application/json', modifiedTime: '' })
})

describe('saveDriveDocument', () => {
  it('writes without reading when the document is still at the version saved here', async () => {
    driveHolds('3', saved)
    expect(await saveDriveDocument(changed, location, saved)).toEqual({ kind: 'saved', location: { kind: 'drive', fileId: 'doc', version: '4' } })
    expect(writeFile).toHaveBeenCalledWith(projectToFile(changed), { id: 'doc' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('writes when only the version changed, not the project', async () => {
    // An older version of the editor wrote the same project.
    driveHolds('5', example)
    expect(await saveDriveDocument(changed, location, saved)).toMatchObject({ kind: 'saved', location: { version: '4' } })
  })

  it('writes nothing to a document changed elsewhere, and returns what it holds at which version', async () => {
    driveHolds('5', projectToFile(changed))
    const result = await saveDriveDocument(project, location, saved)
    expect(result).toMatchObject({ kind: 'changedElsewhere', inDrive: { content: projectToFile(changed) }, location: { ...location, version: '5' } })
    expect(result.kind === 'changedElsewhere' && result.inDrive.project?.settings.snap).toBe(1)
    expect(writeFile).not.toHaveBeenCalled()
    expect(fileVersion).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('returns a document that is no project anymore as changed elsewhere, without a project', async () => {
    driveHolds('5', 'hello')
    expect(await saveDriveDocument(project, location, saved)).toMatchObject({ kind: 'changedElsewhere', inDrive: { project: null, content: 'hello' } })
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe('overwriteDriveDocument', () => {
  it('writes without looking at what the document holds', async () => {
    expect(await overwriteDriveDocument(project, location)).toEqual({ kind: 'drive', fileId: 'doc', version: '4' })
    expect(writeFile).toHaveBeenCalledWith(saved, { id: 'doc' })
    expect(fileVersion).not.toHaveBeenCalled()
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
