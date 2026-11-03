// Projects saved as documents in Google Drive: the counterpart of projectFiles.ts, for the editor's
// own folder in Drive instead of files on this computer.

import { documentVersion, listDocuments, listFiles, readDocument, removeFile, renameDocument, writeDocument, type DriveDocument } from './googleDrive'
import { compareSaved, readSavedProject, type FileComparison } from './projectFiles'
import { projectFromFile, projectToFile, type ProjectFile, type ProjectLocation } from './projectStore'
import type { Project } from './types'

export type DriveLocation = Extract<ProjectLocation, { kind: 'drive' }>

// Before documents, Drive kept a copy of the open tabs: a workspace file and a file per tab. Those
// tab files become documents named after their projects.
const OLD_WORKSPACE_FILE = 'workspace.json'
const OLD_TAB_FILE = /^tab-.+\.manhattan\.json$/

async function convertOldTabs() {
  const files = await listFiles()
  const workspace = files.find((file) => file.name === OLD_WORKSPACE_FILE)
  if (!workspace) return
  for (const file of files) {
    if (OLD_TAB_FILE.test(file.name)) await renameDocument(file.id, projectFromFile(await readDocument(file.id)).name)
  }
  await removeFile(workspace.id)
}

/** The projects saved in Google Drive, most recently changed first. */
export async function listDriveDocuments(): Promise<DriveDocument[]> {
  await convertOldTabs()
  return listDocuments()
}

export async function openDriveDocument(fileId: string): Promise<{ project: Project; location: DriveLocation }> {
  const version = await documentVersion(fileId)
  const project = projectFromFile(await readDocument(fileId))
  return { project, location: { kind: 'drive', fileId, version } }
}

/**
 * Writes `project` to its document, or to a new one without `location`. A document that changed
 * elsewhere since `savedContent` is only overwritten when `confirmOverwrite` says so. Returns where
 * it was written, or null when nothing was saved.
 */
export async function saveDriveDocument(
  project: Project,
  location: DriveLocation | undefined,
  savedContent: string,
  confirmOverwrite: (name: string) => Promise<boolean>,
): Promise<DriveLocation | null> {
  if (location && (await documentVersion(location.fileId)) !== location.version) {
    const inDrive = readSavedProject(await readDocument(location.fileId))
    if (inDrive.content !== savedContent && !(await confirmOverwrite(project.name))) return null
  }
  const written = await writeDocument(project.name, projectToFile(project), location?.fileId)
  return { kind: 'drive', fileId: written.id, version: written.version }
}

/** How the document stands against the tab, and its current version. Throws when it cannot be read or is no project anymore. */
export async function compareWithDrive(location: DriveLocation, file: ProjectFile): Promise<{ comparison: FileComparison; location: DriveLocation }> {
  const version = await documentVersion(location.fileId)
  if (version === location.version) return { comparison: { kind: 'unchanged', content: file.savedContent }, location }
  return { comparison: compareSaved(await readDocument(location.fileId), file), location: { ...location, version } }
}
