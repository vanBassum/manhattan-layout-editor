// Where the tabs' projects are saved: saving, opening, checking a saved document against its tab's
// recovery copy after a reload, saving Google Drive documents by themselves, and signing in to Google.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { compareWithDrive, openDriveDocument, overwriteDriveDocument, saveDriveDocument, saveInDriveFolder, type DriveLocation } from '../documents/driveDocuments'
import { driveConfigured, isSignedIn, onSignInChange, signIn, SignInNeeded } from '../documents/googleDrive'
import { canUseFiles, compareWithFile, mayUse, pickFileToOpen, readFile, saveToFile, saveToNewFile, type FileComparison } from '../documents/projectFiles'
import { projectFileName, projectFromFile, projectNameOf, projectToFile } from '../documents/projectFormat'
import {
  acceptSavedContent,
  fileStatusVersion,
  forgetRecent,
  onFileChange,
  projectFile,
  rememberRecent,
  setSavedProject,
  tabShowing,
  unlinkLocation,
  type ProjectFile,
  type ProjectLocation,
  type RecentDocument,
} from '../documents/projectStore'
import { errorText } from '../errorText'
import { downloadText } from '../exportSvg'
import type { SaveChoice } from './FileDialog'
import type { Project } from '../types'
import type { TabSession } from './useTabs'

const DRIVE_AUTOSAVE_MS = 2000

/** The saved document changed elsewhere while tab `id` has unsaved changes: the user picks. */
export interface FileConflict {
  id: string
  project: Project
  content: string
  location: ProjectLocation
}

/** The Open or Save dialog; a save resolves with where to save, or null when closed. */
export type FileDialogState = { mode: 'open' } | { mode: 'save'; name: string; resolve: (choice: SaveChoice | null) => void }

/** A saved project's new place, and the name it is saved under. */
type SavedAs = { name: string; location: ProjectLocation }

/** `confirm` asks a yes/no question; true when the user picks `confirmLabel` rather than Cancel. */
export function useDocuments(
  tabs: TabSession,
  setError: (error: string) => void,
  confirm: (title: string, text: string, confirmLabel: string) => Promise<boolean>,
) {
  // Checks and autosave follow the shown tab and its project as rendered.
  const { tabsRef, activeIdRef, activeId, project, shownProject, tabName, renameTab, switchTab, openInNewTab, commitEdit } = tabs

  // projectFile is read while rendering; this re-renders when a tab gets or loses unsaved changes,
  // or its saved document is checked.
  const fileStatus = useSyncExternalStore(onFileChange, fileStatusVersion)

  const [signedIn, setSignedIn] = useState(isSignedIn)
  useEffect(() => onSignInChange(() => setSignedIn(isSignedIn())), [])

  /** Signs in with Google; call it from a click. False when it did not work out. */
  const signInToGoogle = async (): Promise<boolean> => {
    try {
      await signIn()
      return true
    } catch (e) {
      setError(`Could not sign in with Google: ${errorText(e)}`)
      return false
    }
  }

  const confirmOverwrite = (name: string) => confirm(`Overwrite "${name}"?`, 'It changed elsewhere since it was opened or saved here.', 'Overwrite')

  const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null)
  const showOpenDialog = () => setFileDialog({ mode: 'open' })
  const closeFileDialog = () => (fileDialog?.mode === 'save' ? fileDialog.resolve(null) : setFileDialog(null))

  /** Asks where to save project `name`; without Google Drive there is only this computer, whose own dialog asks. */
  const askSaveAs = (name: string) =>
    driveConfigured
      ? new Promise<SaveChoice | null>((resolve) =>
          setFileDialog({
            mode: 'save',
            name,
            resolve: (choice) => {
              setFileDialog(null)
              resolve(choice)
            },
          }),
        )
      : Promise.resolve<SaveChoice>({ place: 'local', name })

  /** Writes `project` where it is saved; null when nothing was saved. */
  const saveToLocation = async (project: Project, name: string, file: ProjectFile, location: ProjectLocation): Promise<ProjectLocation | null> => {
    if (location.kind === 'drive') {
      if (!isSignedIn() && !(await signInToGoogle())) return null
      const result = await saveDriveDocument(project, location, file.savedContent)
      if (result.kind === 'saved') return result.location
      return (await confirmOverwrite(name)) ? overwriteDriveDocument(project, location) : null
    }
    return (await saveToFile(project, location.handle, file.savedContent, confirmOverwrite)) ? location : null
  }

  /** Saves `project` as `name` in Google Drive folder `folderId`. */
  const saveToNewDriveDocument = async (project: Project, name: string, folderId: string): Promise<SavedAs | null> => {
    const location = await saveInDriveFolder(project, name, folderId, confirmOverwrite)
    return location && { name, location }
  }

  /** Saves `project` to a file picked in the computer's own save dialog, offered as `name`. */
  const saveToNewLocalFile = async (project: Project, name: string): Promise<SavedAs | null> => {
    const handle = await saveToNewFile(project, name)
    return handle && { name: projectNameOf(handle.name), location: { kind: 'local', handle } }
  }

  /**
   * Saves tab `id` where it is saved. A project without a location, or with `saveAs`, asks for a name
   * and a place; the computer's own save dialog or Google's picker then chooses the folder. The tab
   * continues there, under the file's name, and the original stays as it was. False when nothing was saved.
   */
  const saveTab = async (id: string, saveAs = false): Promise<boolean> => {
    const file = projectFile(id)
    const current = shownProject(id)
    try {
      let saved: SavedAs | null
      if (file.location && !saveAs) {
        const location = await saveToLocation(current, tabName(id), file, file.location)
        saved = location && { name: tabName(id), location }
      } else {
        const choice = await askSaveAs(tabName(id))
        if (!choice) return false
        if (choice.place === 'local' && !canUseFiles) {
          downloadText(projectFileName(choice.name), projectToFile(current), 'application/json')
          setSavedProject(id, current)
          renameTab(id, choice.name)
          return true
        }
        saved = choice.place === 'drive' ? await saveToNewDriveDocument(current, choice.name, choice.folderId) : await saveToNewLocalFile(current, choice.name)
      }
      if (!saved) return false
      setSavedProject(id, current, saved.location)
      renameTab(id, saved.name)
      rememberRecent(saved.name, saved.location)
      return true
    } catch (e) {
      setError(`Could not save: ${errorText(e)}`)
      return false
    }
  }

  /** Opens the document at `location` in a new tab, or shows the tab that already has it. */
  const openLocation = async (location: ProjectLocation) => {
    const shown = await tabShowing(location)
    if (shown) return switchTab(shown)
    if (location.kind === 'local') {
      if (!(await mayUse(location.handle, true))) throw new Error(`no permission to open "${location.handle.name}"`)
      return openInNewTab(projectFromFile(await readFile(location.handle)), projectNameOf(location.handle.name), location)
    }
    if (!isSignedIn() && !(await signInToGoogle())) return
    const opened = await openDriveDocument(location.fileId)
    openInNewTab(opened.project, opened.name, opened.location)
  }

  const openRecent = async (recent: RecentDocument) => {
    setFileDialog(null)
    try {
      await openLocation(recent.location)
    } catch (e) {
      forgetRecent(recent.location)
      setError(`Could not open "${recent.name}" (${errorText(e)}); it is taken off the recent projects.`)
    }
  }

  // Without the File System Access API a project file is uploaded through this hidden input.
  const uploadInputRef = useRef<HTMLInputElement>(null)

  /** A project file from anywhere on this computer, through the computer's own dialog (or an upload). */
  const openProjectFile = async () => {
    setFileDialog(null)
    if (!canUseFiles) {
      uploadInputRef.current!.click()
      return
    }
    try {
      const handle = await pickFileToOpen()
      if (handle) await openLocation({ kind: 'local', handle })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const openUploadedFile = async (file: File | undefined) => {
    if (!file) return
    uploadInputRef.current!.value = ''
    try {
      openInNewTab(projectFromFile(await file.text()), projectNameOf(file.name))
    } catch (e) {
      setError(errorText(e))
    }
  }

  const openFromDrive = async (fileId: string) => {
    setFileDialog(null)
    try {
      await openLocation({ kind: 'drive', fileId, version: '' })
    } catch (e) {
      setError(`Could not open from Google Drive: ${errorText(e)}`)
    }
  }

  const [fileConflict, setFileConflict] = useState<FileConflict | null>(null)

  /**
   * After a reload the tab shows its recovery copy. Compares the saved document with it: an
   * unchanged document needs nothing, one changed elsewhere replaces a copy without unsaved changes,
   * and with changes on both sides the user picks. Without permission or sign-in yet (`ask` false)
   * it waits for a click.
   */
  const checkSaved = async (id: string, ask: boolean) => {
    const file = projectFile(id)
    const location = file.location
    if (!location || file.checked) return
    try {
      if (location.kind === 'local') {
        if (!(await mayUse(location.handle, ask))) return
        showComparison(id, await compareWithFile(location.handle, file), location)
      } else {
        if (!isSignedIn() && !(ask && (await signInToGoogle()))) return
        const checked = await compareWithDrive(location, file)
        showComparison(id, checked.comparison, checked.location)
      }
    } catch (e) {
      if (e instanceof SignInNeeded) return
      // Moved, deleted or damaged: keep working on the recovery copy; Save asks for a new location.
      setError(`Could not read "${tabName(id)}" (${errorText(e)}). Showing the recovery copy.`)
      unlinkLocation(id)
    }
  }

  const showComparison = (id: string, comparison: FileComparison, location: ProjectLocation) => {
    if (id !== activeIdRef.current) return
    if (comparison.kind === 'unchanged') acceptSavedContent(id, comparison.content, location)
    else if (comparison.kind === 'newer') loadSavedVersion(id, comparison.project, location)
    else setFileConflict({ id, project: comparison.project, content: comparison.content, location })
  }

  const loadSavedVersion = (id: string, saved: Project, location: ProjectLocation) => {
    // The changes it replaces stay reachable with Undo.
    commitEdit(() => saved)
    setSavedProject(id, saved, location)
    setFileConflict(null)
  }

  const keepRecoveryCopy = (id: string, savedContent: string, location: ProjectLocation) => {
    acceptSavedContent(id, savedContent, location)
    setFileConflict(null)
  }

  // On showing a tab, and on signing in; later checks come from the banner's button.
  useEffect(() => {
    checkSaved(activeId, false)
  }, [activeId, signedIn])

  // A Google Drive document saves itself a moment after the last change. One that changed in Drive
  // meanwhile is not overwritten: the tab shows both versions to pick from.
  const autosaving = useRef(new Set<string>())
  useEffect(() => {
    if (!signedIn) return
    const timer = setTimeout(() => {
      for (const tab of tabsRef.current) {
        const file = projectFile(tab.id)
        if (file.location?.kind === 'drive' && file.dirty && file.checked && fileConflict?.id !== tab.id) autosave(tab.id, file.location)
      }
    }, DRIVE_AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [project, fileStatus, signedIn, fileConflict])

  const autosave = async (id: string, location: DriveLocation) => {
    if (autosaving.current.has(id)) return
    autosaving.current.add(id)
    const toSave = shownProject(id)
    try {
      const result = await saveDriveDocument(toSave, location, projectFile(id).savedContent)
      // Changes made while saving stay unsaved, and save in turn.
      if (result.kind === 'saved') acceptSavedContent(id, projectToFile(toSave), result.location)
      else if (!result.inDrive.project) setError(`Could not save "${tabName(id)}" to Google Drive: it is not a Manhattan project anymore`)
      else setFileConflict({ id, project: result.inDrive.project, content: result.inDrive.content, location: result.location })
    } catch (e) {
      if (!(e instanceof SignInNeeded)) setError(`Could not save "${tabName(id)}" to Google Drive: ${errorText(e)}`)
    } finally {
      autosaving.current.delete(id)
    }
  }

  return {
    signedIn,
    signInToGoogle,
    saveTab,
    fileDialog,
    showOpenDialog,
    closeFileDialog,
    openRecent,
    openFromDrive,
    openProjectFile,
    uploadInputRef,
    openUploadedFile,
    fileConflict,
    checkSaved,
    loadSavedVersion,
    keepRecoveryCopy,
  }
}
