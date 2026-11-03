// Projects saved in Google Drive: the counterpart of projectFiles.ts, for files in Drive instead of
// on this computer.

import { fileVersion, findFile, readFile, writeFile } from './googleDrive'
import { compareSaved, readSavedProject, type FileComparison } from './projectFiles'
import { projectFromFile, projectToFile, type ProjectFile, type ProjectLocation } from './projectStore'
import type { Project } from './types'

export type DriveLocation = Extract<ProjectLocation, { kind: 'drive' }>

export async function openDriveDocument(fileId: string): Promise<{ project: Project; location: DriveLocation }> {
  const version = await fileVersion(fileId)
  const project = projectFromFile(await readFile(fileId))
  return { project, location: { kind: 'drive', fileId, version } }
}

/**
 * Writes `project` to its document. One that changed elsewhere since `savedContent` is only
 * overwritten when `confirmOverwrite` says so. Returns its new version, or null when nothing was saved.
 */
export async function saveDriveDocument(
  project: Project,
  location: DriveLocation,
  savedContent: string,
  confirmOverwrite: (name: string) => Promise<boolean>,
): Promise<DriveLocation | null> {
  if ((await fileVersion(location.fileId)) !== location.version) {
    const inDrive = readSavedProject(await readFile(location.fileId))
    if (inDrive.content !== savedContent && !(await confirmOverwrite(project.name))) return null
  }
  const written = await writeFile(`${project.name}.manhattan.json`, projectToFile(project), { id: location.fileId })
  return { kind: 'drive', fileId: written.id, version: written.version }
}

/**
 * Saves `project` under its name in Drive folder `folderId`. A project of that name already there
 * is only replaced when `confirmOverwrite` says so. Returns where it was written, or null when not.
 */
export async function saveInDriveFolder(
  project: Project,
  folderId: string,
  confirmOverwrite: (name: string) => Promise<boolean>,
): Promise<DriveLocation | null> {
  const fileName = `${project.name}.manhattan.json`
  const existing = await findFile(folderId, fileName)
  if (existing && !(await confirmOverwrite(project.name))) return null
  const written = await writeFile(fileName, projectToFile(project), existing ? { id: existing.id } : { parentId: folderId })
  return { kind: 'drive', fileId: written.id, version: written.version }
}

/** Saves `project` over Drive file `fileId`, keeping its file name. */
export async function replaceDriveFile(project: Project, fileId: string, fileName: string): Promise<DriveLocation> {
  const written = await writeFile(fileName, projectToFile(project), { id: fileId })
  return { kind: 'drive', fileId: written.id, version: written.version }
}

/** How the document stands against the tab, and its current version. Throws when it cannot be read or is no project anymore. */
export async function compareWithDrive(location: DriveLocation, file: ProjectFile): Promise<{ comparison: FileComparison; location: DriveLocation }> {
  const version = await fileVersion(location.fileId)
  if (version === location.version) return { comparison: { kind: 'unchanged', content: file.savedContent }, location }
  return { comparison: compareSaved(await readFile(location.fileId), file), location: { ...location, version } }
}
