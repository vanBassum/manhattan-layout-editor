// Projects saved in Google Drive: the counterpart of projectFiles.ts, for files in Drive instead of
// on this computer. A project is called by its file's name.

import { fileInfo, fileVersion, findFile, readFile, writeFile } from './googleDrive'
import { compareSaved, projectNameOf, readSavedProject, type FileComparison } from './projectFiles'
import { projectFromFile, projectToFile, type ProjectFile, type ProjectLocation } from './projectStore'
import type { Project } from './types'

export type DriveLocation = Extract<ProjectLocation, { kind: 'drive' }>

const driveLocation = (written: { id: string; version: string }): DriveLocation => ({ kind: 'drive', fileId: written.id, version: written.version })

export async function openDriveDocument(fileId: string): Promise<{ project: Project; name: string; location: DriveLocation }> {
  const info = await fileInfo(fileId)
  const project = projectFromFile(await readFile(fileId))
  return { project, name: projectNameOf(info.name), location: { kind: 'drive', fileId, version: info.version } }
}

/**
 * Writes `project` to its document, called `name`. One that changed elsewhere since `savedContent`
 * is only overwritten when `confirmOverwrite` says so. Returns its new version, or null when nothing
 * was saved.
 */
export async function saveDriveDocument(
  project: Project,
  name: string,
  location: DriveLocation,
  savedContent: string,
  confirmOverwrite: (name: string) => Promise<boolean>,
): Promise<DriveLocation | null> {
  if ((await fileVersion(location.fileId)) !== location.version) {
    const inDrive = readSavedProject(await readFile(location.fileId))
    if (inDrive.content !== savedContent && !(await confirmOverwrite(name))) return null
  }
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
  const fileName = `${name}.manhattan.json`
  const existing = await findFile(folderId, fileName)
  if (existing && !(await confirmOverwrite(name))) return null
  const text = projectToFile(project)
  return driveLocation(await writeFile(text, existing ? { id: existing.id } : { parentId: folderId, name: fileName }))
}

/** Saves `project` over Drive file `fileId`, which keeps its name. */
export async function replaceDriveFile(project: Project, fileId: string): Promise<DriveLocation> {
  return driveLocation(await writeFile(projectToFile(project), { id: fileId }))
}

/** How the document stands against the tab, and its current version. Throws when it cannot be read or is no project anymore. */
export async function compareWithDrive(location: DriveLocation, file: ProjectFile): Promise<{ comparison: FileComparison; location: DriveLocation }> {
  const version = await fileVersion(location.fileId)
  if (version === location.version) return { comparison: { kind: 'unchanged', content: file.savedContent }, location }
  return { comparison: compareSaved(await readFile(location.fileId), file), location: { ...location, version } }
}
