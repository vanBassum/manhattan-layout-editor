import { beforeEach, describe, expect, it, vi } from 'vitest'
import example from '../examples/Astable multivibrator.json?raw'
import { compareWithDrive, openDriveDocument, overwriteDriveDocument, saveDriveDocument, type DriveLocation } from './driveDocuments'
import { fileInfo, readFile, writeFile } from './googleDrive'
import { projectFromFile, projectToFile } from './projectFormat'
import type { ProjectFile } from './projectStore'

vi.mock('./googleDrive', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileInfo: vi.fn(),
  findFile: vi.fn(),
}))

const project = projectFromFile(example)
const saved = projectToFile(project)
const changed = { ...project, settings: { ...project.settings, snap: 1 } }
const location: DriveLocation = { kind: 'drive', fileId: 'doc' }
/** The tab saved or opened the document "amp" at version 3. */
const file = (dirty: boolean): ProjectFile => ({ location, savedContent: saved, driveRevision: { version: '3', name: 'amp' }, dirty, checked: false })

/** The document in Drive is file `name` at `version`, and holds `text`. */
function driveHolds(version: string, text: string, name = 'amp.manhattan.json') {
  vi.mocked(fileInfo).mockResolvedValue({ name, version })
  vi.mocked(readFile).mockResolvedValue(text)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(writeFile).mockResolvedValue({ id: 'doc', version: '4', name: 'amp.json', mimeType: 'application/json', modifiedTime: '' })
})

describe('openDriveDocument', () => {
  it('names the document after its file, and keeps its version', async () => {
    driveHolds('3', saved, 'Amplifier.manhattan.json')
    expect(await openDriveDocument('doc')).toMatchObject({ location, revision: { version: '3', name: 'Amplifier' } })
  })
})

describe('saveDriveDocument', () => {
  it('writes without reading when the document is still at the version saved here', async () => {
    driveHolds('3', saved)
    expect(await saveDriveDocument(changed, location, file(true))).toEqual({ kind: 'saved', revision: { version: '4', name: 'amp' } })
    expect(writeFile).toHaveBeenCalledWith(projectToFile(changed), { id: 'doc' })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('writes when only the version changed, not the project', async () => {
    // An older version of the editor wrote the same project.
    driveHolds('5', example)
    expect(await saveDriveDocument(changed, location, file(true))).toMatchObject({ kind: 'saved', revision: { version: '4' } })
  })

  it('writes nothing to a document changed elsewhere, and returns what it holds at which version', async () => {
    driveHolds('5', projectToFile(changed))
    const result = await saveDriveDocument(project, location, file(false))
    expect(result).toMatchObject({ kind: 'changedElsewhere', inDrive: { content: projectToFile(changed) }, revision: { version: '5' } })
    expect(result.kind === 'changedElsewhere' && result.inDrive.project?.settings.snap).toBe(1)
    expect(writeFile).not.toHaveBeenCalled()
    expect(fileInfo).toHaveBeenCalledTimes(1)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('returns a document that is no project anymore as changed elsewhere, without a project', async () => {
    driveHolds('5', 'hello')
    expect(await saveDriveDocument(project, location, file(false))).toMatchObject({ kind: 'changedElsewhere', inDrive: { project: null, content: 'hello' } })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('refuses a tab that does not know which version it saved', async () => {
    driveHolds('3', saved)
    await expect(saveDriveDocument(changed, location, { ...file(true), driveRevision: undefined })).rejects.toThrow('its version in Google Drive is not known')
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe('overwriteDriveDocument', () => {
  it('writes without looking at what the document holds', async () => {
    expect(await overwriteDriveDocument(project, location)).toEqual({ version: '4', name: 'amp' })
    expect(writeFile).toHaveBeenCalledWith(saved, { id: 'doc' })
    expect(fileInfo).not.toHaveBeenCalled()
  })
})

describe('compareWithDrive', () => {
  it('does not read a document still at the version saved here', async () => {
    driveHolds('3', 'unread')
    expect(await compareWithDrive(location, file(false))).toEqual({ comparison: { kind: 'unchanged', content: saved }, revision: { version: '3', name: 'amp' } })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('reads a document at a newer version, and returns that version', async () => {
    driveHolds('5', projectToFile(changed))
    const newer = await compareWithDrive(location, file(false))
    expect(newer.comparison).toMatchObject({ kind: 'newer', content: projectToFile(changed) })
    expect(newer.revision).toEqual({ version: '5', name: 'amp' })
    expect((await compareWithDrive(location, file(true))).comparison).toMatchObject({ kind: 'conflict' })
  })

  it('returns the name the document has in Drive now, after it was renamed there', async () => {
    driveHolds('6', saved, 'Amplifier v2.json')
    expect(await compareWithDrive(location, file(false))).toEqual({ comparison: { kind: 'unchanged', content: saved }, revision: { version: '6', name: 'Amplifier v2' } })
  })

  it('refuses a document that is no project anymore', async () => {
    driveHolds('5', 'hello')
    await expect(compareWithDrive(location, file(false))).rejects.toThrow('not a Manhattan project')
  })
})
