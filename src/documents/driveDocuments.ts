// Projects saved in Google Drive: the counterpart of projectFiles.ts, for files in Drive instead of
// on this computer. A project is called by its file's name.

import type { Project } from '../model/types'
import { fileInfo, findFile, readFile, writeFile } from './googleDrive'
import { compareSaved, type FileComparison } from './projectFiles'
import { projectFileName, projectFromFile, projectNameOf, projectToFile, readSavedProject } from './projectFormat'
import type { DriveRevision, ProjectFile, ProjectLocation } from './projectStore'

export type DriveLocation = Extract<ProjectLocation, { kind: 'drive' }>

/** The revision of a Drive file as Drive describes it. */
const revisionOf = (file: { name: string; version: string }): DriveRevision => ({ version: file.version, name: projectNameOf(file.name) })

/** The revision tab `file` last saved or opened; a Drive document without one cannot be compared. */
function savedRevision(file: ProjectFile): DriveRevision {
  if (!file.driveRevision) throw new Error('its version in Google Drive is not known')
  return file.driveRevision
}

export async function openDriveDocument(fileId: string): Promise<{ project: Project; location: DriveLocation; revision: DriveRevision }> {
  const info = await fileInfo(fileId)
  const project = projectFromFile(await readFile(fileId))
  return { project, location: { kind: 'drive', fileId }, revision: revisionOf(info) }
}

/**
 * What saving to a document did: write it (now at `revision`), or leave a document that changed
 * elsewhere alone. Then `inDrive` is what it holds now, at `revision`; its project is null when it
 * is no project.
 */
export type DriveSave =
  | { kind: 'saved'; revision: DriveRevision }
  | { kind: 'changedElsewhere'; inDrive: { project: Project | null; content: string }; revision: DriveRevision }

/** Writes `project` to its document, unless that changed elsewhere since tab `file` last saved or opened it. */
export async function saveDriveDocument(project: Project, location: DriveLocation, file: ProjectFile): Promise<DriveSave> {
  const now = revisionOf(await fileInfo(location.fileId))
  if (now.version !== savedRevision(file).version) {
    const inDrive = readSavedProject(await readFile(location.fileId))
    if (inDrive.content !== file.savedContent) return { kind: 'changedElsewhere', inDrive, revision: now }
  }
  return { kind: 'saved', revision: await overwriteDriveDocument(project, location) }
}

/** Writes `project` to its document, whatever that holds now. Returns its new revision. */
export async function overwriteDriveDocument(project: Project, location: DriveLocation): Promise<DriveRevision> {
  return revisionOf(await writeFile(projectToFile(project), { id: location.fileId }))
}

/**
 * Saves `project` as `name` in Drive folder `folderId`. A project of that name already there is
 * only replaced when `confirmOverwrite` says so. Returns where it was written, or null when not.
 */
export async function saveInDriveFolder(
  project: Project,
  name: string,
  folderId: string,
  confirmOverwrite: (name: string) => Promise<boolean>,
): Promise<{ location: DriveLocation; revision: DriveRevision } | null> {
  const fileName = projectFileName(name)
  const existing = await findFile(folderId, fileName)
  if (existing && !(await confirmOverwrite(name))) return null
  const written = await writeFile(projectToFile(project), existing ? { id: existing.id } : { parentId: folderId, name: fileName })
  return { location: { kind: 'drive', fileId: written.id }, revision: revisionOf(written) }
}

/**
 * How the document stands against the tab, and its current revision, which has its current name.
 * Throws when it cannot be read or is no project anymore.
 */
export async function compareWithDrive(location: DriveLocation, file: ProjectFile): Promise<{ comparison: FileComparison; revision: DriveRevision }> {
  const saved = savedRevision(file)
  const now = revisionOf(await fileInfo(location.fileId))
  if (now.version === saved.version) return { comparison: { kind: 'unchanged', content: file.savedContent }, revision: now }
  return { comparison: compareSaved(await readFile(location.fileId), file), revision: now }
}
