import { useEffect, useRef, useState } from 'react'
import { errorText } from './errorText'
import { driveConfigured, isFolder, listFolder, projectsFolder, SAVE_FOLDER_NAME, SignInNeeded, type DriveItem } from './googleDrive'
import { pickDriveFile, pickDriveFolder } from './googlePicker'
import { Icon } from './panels'
import { projectNameOf, type RecentDocument } from './projectStore'

/** Where Save puts the project: through the computer's own save dialog, or in a Google Drive folder. */
export type SaveChoice = { place: 'local'; name: string } | { place: 'drive'; name: string; folderId: string }

interface FileDialogProps {
  mode: 'open' | 'save'
  /** Save: the name to start from. */
  name?: string
  recent: RecentDocument[]
  signedIn: boolean
  onSignIn: () => Promise<boolean>
  onOpenRecent: (recent: RecentDocument) => void
  onOpenDrive: (fileId: string) => void
  onOpenLocal: () => void
  onSave: (choice: SaveChoice) => void
  onClose: () => void
}

interface DriveFolder {
  id: string
  name: string
}

/** The Drive folders shown last, so the dialog opens there again in this session. */
let lastDrivePath: DriveFolder[] | null = null

const isProjectFile = (item: DriveItem) => /\.json$/i.test(item.name)
const formatModified = (time: string) => new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatSize = (size?: string) => (size ? `${Math.max(1, Math.round(Number(size) / 1024))} KB` : '—')

/**
 * Open and Save: on the left the places, on the right what is in them. This computer hands over to
 * the computer's own file dialog straight away; Google Drive shows its folders here.
 */
export function FileDialog(props: FileDialogProps) {
  const { mode, recent, signedIn } = props
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])

  const [place, setPlace] = useState<'recent' | 'drive'>(mode === 'open' && (recent.length > 0 || !driveConfigured) ? 'recent' : 'drive')
  const [path, setPath] = useState<DriveFolder[] | null>(lastDrivePath)
  const [items, setItems] = useState<DriveItem[] | null>(null)
  const [problem, setProblem] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState(props.name ?? '')
  const folder = path?.[path.length - 1]
  const trimmed = name.trim()

  // Without a folder yet, Drive starts in the projects folder.
  useEffect(() => {
    if (place !== 'drive' || !signedIn || path) return
    projectsFolder().then(
      (id) => setPath([{ id, name: SAVE_FOLDER_NAME }]),
      (e) => setProblem(`Could not open Google Drive: ${errorText(e)}`),
    )
  }, [place, signedIn, path])

  useEffect(() => {
    lastDrivePath = path
    setItems(null)
    setSelected(null)
    if (place !== 'drive' || !signedIn || !folder) return
    let current = true
    listFolder(folder.id).then(
      (listed) => current && setItems(listed.filter((item) => isFolder(item) || isProjectFile(item))),
      (e) => current && setProblem(e instanceof SignInNeeded ? '' : `Could not read this folder: ${errorText(e)}`),
    )
    return () => {
      current = false
    }
  }, [place, signedIn, folder?.id])

  /** Google's picker opens outside this dialog, which as a modal would block it: the dialog steps aside meanwhile. */
  const steppingAside = useRef(false)
  const withDialogAside = async <T,>(show: () => Promise<T>): Promise<T> => {
    steppingAside.current = true
    dialogRef.current?.close()
    try {
      return await show()
    } finally {
      dialogRef.current?.showModal()
      steppingAside.current = false
    }
  }
  // The close event comes later than close(): by then the dialog may be back.
  const onDialogClose = () => !steppingAside.current && !dialogRef.current?.open && props.onClose()

  const openFolder = (item: DriveItem) => setPath([...(path ?? []), { id: item.id, name: item.name }])

  const otherDriveLocation = async () => {
    try {
      if (mode === 'open') {
        const picked = await withDialogAside(pickDriveFile)
        if (picked) props.onOpenDrive(picked.id)
      } else {
        const picked = await withDialogAside(pickDriveFolder)
        // The picker gives no way back up, so the chosen folder starts the path.
        if (picked) setPath([{ id: picked.id, name: picked.name }])
      }
    } catch (e) {
      setProblem(`Could not use Google Drive: ${errorText(e)}`)
    }
  }

  const activate = (item: DriveItem) => {
    if (isFolder(item)) return openFolder(item)
    if (mode === 'open') return props.onOpenDrive(item.id)
    setName(projectNameOf(item.name))
    if (folder) props.onSave({ place: 'drive', name: projectNameOf(item.name), folderId: folder.id })
  }

  const select = (item: DriveItem) => {
    setSelected(item.id)
    if (mode === 'save' && !isFolder(item)) setName(projectNameOf(item.name))
  }

  const saveInDrive = () => folder && trimmed && props.onSave({ place: 'drive', name: trimmed, folderId: folder.id })
  const selectedItem = items?.find((item) => item.id === selected)

  return (
    <dialog ref={dialogRef} className="ai-dialog fd" onClose={onDialogClose}>
      <header>
        <h2>
          <Icon name={mode === 'open' ? 'open' : 'save'} />
          {mode === 'open' ? 'Open project' : 'Save project'}
        </h2>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>

      <div className="fd-body">
        <nav className="fd-places" aria-label="Places">
          {mode === 'open' && (
            <button className={place === 'recent' ? 'fd-place active' : 'fd-place'} onClick={() => setPlace('recent')}>
              <Icon name="clock" />
              <span>
                <strong>Recent</strong>
                <small>Projects opened or saved lately</small>
              </span>
            </button>
          )}
          {driveConfigured && (
            <button className={place === 'drive' ? 'fd-place active' : 'fd-place'} onClick={() => setPlace('drive')}>
              <Icon name="cloud" />
              <span>
                <strong>Google Drive</strong>
                <small>{mode === 'open' ? 'Open a project from your Drive' : 'Save in a folder in your Drive'}</small>
              </span>
            </button>
          )}
          <button
            className="fd-place"
            onClick={() => (mode === 'open' ? props.onOpenLocal() : trimmed && props.onSave({ place: 'local', name: trimmed }))}
            disabled={mode === 'save' && !trimmed}
          >
            <Icon name="computer" />
            <span>
              <strong>This computer…</strong>
              <small>Opens the Windows file browser</small>
            </span>
            <Icon name="external" />
          </button>
          {driveConfigured && (
            <p className="fd-note">
              <Icon name="help" />
              <span>
                Google Drive shows the projects the editor saved, and those opened before. For other files use "
                {mode === 'open' ? 'Other file in Drive…' : 'Other folder in Drive…'}".
              </span>
            </p>
          )}
        </nav>

        <section className="fd-main">
          {place === 'recent' ? (
            <div className="fd-list">
              {recent.length === 0 ? (
                <p className="fd-empty">No recent projects yet.</p>
              ) : (
                recent.map((document, k) => (
                  <button key={k} className="fd-row" onClick={() => props.onOpenRecent(document)}>
                    <span className="fd-name">
                      <Icon name={document.location.kind === 'drive' ? 'cloud' : 'computer'} />
                      {document.name}
                    </span>
                    <span>{document.location.kind === 'drive' ? 'Google Drive' : 'This computer'}</span>
                    <span />
                  </button>
                ))
              )}
            </div>
          ) : !signedIn ? (
            <div className="fd-list fd-empty">
              <p>Sign in to see your projects in Google Drive.</p>
              <button className="header-button" onClick={props.onSignIn}>
                <Icon name="cloud" />Sign in with Google
              </button>
            </div>
          ) : (
            <>
              <div className="fd-bar">
                <button className="icon-button" onClick={() => path && setPath(path.slice(0, -1))} disabled={!path || path.length < 2} aria-label="Up">
                  <Icon name="arrowUp" />
                </button>
                <div className="fd-crumbs">
                  <Icon name="cloud" />
                  <span>Google Drive</span>
                  {path?.map((crumb, k) => (
                    <span key={crumb.id} className="fd-crumb">
                      <Icon name="chevronRight" />
                      <button onClick={() => setPath(path.slice(0, k + 1))} disabled={k === path.length - 1}>
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </div>
                <button className="header-button" onClick={otherDriveLocation}>
                  <Icon name="folder" />
                  {mode === 'open' ? 'Other file in Drive…' : 'Other folder in Drive…'}
                </button>
              </div>
              {problem && (
                <p className="fd-problem" role="alert">
                  {problem}
                  <button className="icon-button" onClick={() => setProblem('')} aria-label="Dismiss">✕</button>
                </p>
              )}
              <div className="fd-list">
                <div className="fd-row fd-head">
                  <span>Name</span>
                  <span>Modified</span>
                  <span>Size</span>
                </div>
                {!items ? (
                  <p className="fd-empty">Loading…</p>
                ) : items.length === 0 ? (
                  <p className="fd-empty">No projects here yet.</p>
                ) : (
                  items.map((item) => (
                    <button
                      key={item.id}
                      className={item.id === selected ? 'fd-row selected' : 'fd-row'}
                      onClick={() => select(item)}
                      onDoubleClick={() => activate(item)}
                    >
                      <span className="fd-name">
                        <Icon name={isFolder(item) ? 'folder' : 'app'} />
                        {isFolder(item) ? item.name : projectNameOf(item.name)}
                      </span>
                      <span>{formatModified(item.modifiedTime)}</span>
                      <span>{isFolder(item) ? '—' : formatSize(item.size)}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {place === 'drive' && signedIn && (
        <footer className="fd-footer">
          {mode === 'save' && (
            <label className="fd-file-name">
              File name
              <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveInDrive()} autoFocus />
            </label>
          )}
          {mode === 'save' ? (
            <button className="primary" onClick={saveInDrive} disabled={!folder || !trimmed}>
              <Icon name="save" />Save
            </button>
          ) : (
            <button className="primary" onClick={() => selectedItem && activate(selectedItem)} disabled={!selectedItem}>
              <Icon name="open" />Open
            </button>
          )}
        </footer>
      )}
    </dialog>
  )
}
