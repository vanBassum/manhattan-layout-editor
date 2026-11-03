// Projects saved in Google Drive: the counterpart of projectFiles.ts, for files in Drive instead of
// on this computer. A project is called by its file's name.

import type { Project } from '../types'
import { fileInfo, fileVersion, findFile, readFile, writeFile } from './googleDrive'
import { compareSaved, type FileComparison } from './projectFiles'
import { projectFileName, projectFromFile, projectNameOf, projectToFile, readSavedProject } from './projectFormat'
import type { ProjectFile, ProjectLocation } from './projectStore'

export type DriveLocation = Extract<ProjectLocation, { kind: 'drive' }>

const driveLocation = (written: { id: string; version: string }): DriveLocation => ({ kind: 'drive', fileId: written.id, version: written.version })

export async function openDriveDocument(fileId: string): Promise<{ project: Project; name: string; location: DriveLocation }> {
  const info = await fileInfo(fileId)
  const project = projectFromFile(await readFile(fileId))
  return { project, name: projectNameOf(info.name), location: { kind: 'drive', fileId, version: info.version } }
}

/**
 * What saving to a document did: write it, or leave a document that changed elsewhere alone. Then
 * `inDrive` is what it holds now, at version `location`; its project is null when it is no project.
 */
export type DriveSave =
  | { kind: 'saved'; location: DriveLocation }
  | { kind: 'changedElsewhere'; inDrive: { project: Project | null; content: string }; location: DriveLocation }

/** Writes `project` to its document, unless that changed elsewhere since `savedContent`. */
export async function saveDriveDocument(project: Project, location: DriveLocation, savedContent: string): Promise<DriveSave> {
  const version = await fileVersion(location.fileId)
  if (version !== location.version) {
    const inDrive = readSavedProject(await readFile(location.fileId))
    if (inDrive.content !== savedContent) return { kind: 'changedElsewhere', inDrive, location: { ...location, version } }
  }
  return { kind: 'saved', location: await overwriteDriveDocument(project, location) }
}

/** Writes `project` to its document, whatever that holds now. Returns its new version. */
export async function overwriteDriveDocument(project: Project, location: DriveLocation): Promise<DriveLocation> {
  return driveLocation(await writeFile(projectToFile(project), { id: location.fileId }))
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
): Promise<DriveLocation | null> {
  const fileName = projectFileName(name)
  const existing = await findFile(folderId, fileName)
  if (existing && !(await confirmOverwrite(name))) return null
  const text = projectToFile(project)
  return driveLocation(await writeFile(text, existing ? { id: existing.id } : { parentId: folderId, name: fileName }))
}

/** How the document stands against the tab, and its current version. Throws when it cannot be read or is no project anymore. */
export async function compareWithDrive(location: DriveLocation, file: ProjectFile): Promise<{ comparison: FileComparison; location: DriveLocation }> {
  const version = await fileVersion(location.fileId)
  if (version === location.version) return { comparison: { kind: 'unchanged', content: file.savedContent }, location }
  return { comparison: compareSaved(await readFile(location.fileId), file), location: { ...location, version } }
}
