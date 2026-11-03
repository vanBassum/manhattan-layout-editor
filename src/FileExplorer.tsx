import { useEffect, useRef, useState } from 'react'
import { errorText } from './errorText'
import {
  canUseFolders,
  entryNamed,
  listEntries,
  makeFolder,
  mayUseFolder,
  pickWorkFolder,
  projectName,
  removeEntry,
  renameEntry,
  type ExplorerEntry,
  type FolderRef,
} from './explorerStorage'
import { driveConfigured, isSignedIn, SignInNeeded } from './googleDrive'
import { pickDriveFile, pickDriveFolder } from './googlePicker'
import { Icon } from './panels'
import { addWorkFolder, removeWorkFolder, savedWorkFolders, type ProjectLocation, type RecentDocument, type WorkFolder } from './projectStore'

interface Crumb {
  name: string
  folder: FolderRef
}

/** What the right side shows: the recent documents, or a folder reached through `path`. */
type Place = { kind: 'recent' } | { kind: 'folder'; path: Crumb[] }

export interface SaveTarget {
  folder: FolderRef
  name: string
  /** The project file it replaces. */
  existing?: ExplorerEntry
}

interface FileExplorerProps {
  mode: 'open' | 'save'
  /** Save: the name to start with. */
  name?: string
  recent: RecentDocument[]
  onSignIn: () => Promise<boolean>
  /** A document open in a tab is not renamed or removed here. */
  isOpenInTab: (location: ProjectLocation) => Promise<boolean>
  confirm: (title: string, text: string, action: string) => Promise<boolean>
  onOpen: (location: ProjectLocation, name: string) => void
  onSave: (target: SaveTarget) => void
  /** A file outside the folders shown here, through the browser's own dialog (or upload and download). */
  onOtherFile: () => void
  onClose: () => void
}

// Where the explorer was last, so it opens there again in this session.
let lastPlace: Place = { kind: 'recent' }

const INVALID_NAME = /[\\/:*?"<>|]/
const formatModified = (time?: number) =>
  time === undefined ? '' : new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const formatSize = (size?: number) => (size === undefined || Number.isNaN(size) ? '' : `${Math.max(1, Math.round(size / 1024))} KB`)
const locationLabel = (location: ProjectLocation) => (location.kind === 'drive' ? 'Google Drive' : 'This computer')

function nameProblem(name: string): string {
  if (!name) return 'Give it a name.'
  if (INVALID_NAME.test(name)) return 'A name cannot contain \\ / : * ? " < > |'
  return ''
}

/** Open and Save as: browse Google Drive and the work folders on this computer, like a file manager. */
export function FileExplorer(props: FileExplorerProps) {
  const { mode, recent, confirm } = props
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])

  const [workFolders, setWorkFolders] = useState(savedWorkFolders)
  const [place, setPlace] = useState<Place>(lastPlace)
  const [back, setBack] = useState<Place[]>([])
  const [forward, setForward] = useState<Place[]>([])
  const [entries, setEntries] = useState<ExplorerEntry[] | null>(null)
  const [reload, setReload] = useState(0)
  const [problem, setProblem] = useState('')
  const [needsPermission, setNeedsPermission] = useState(false)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [makingFolder, setMakingFolder] = useState(false)
  const [choosingWorkspace, setChoosingWorkspace] = useState(false)
  const [name, setName] = useState(props.name ?? '')

  const folder = place.kind === 'folder' ? place.path[place.path.length - 1].folder : null

  useEffect(() => {
    lastPlace = place
    setEntries(null)
    setProblem('')
    setNeedsPermission(false)
    if (!folder) return
    let current = true
    ;(async () => {
      if (folder.kind === 'local' && !(await mayUseFolder(folder.handle, false))) {
        if (current) setNeedsPermission(true)
        return
      }
      const listed = await listEntries(folder)
      if (current) setEntries(listed)
    })().catch((e) => current && setProblem(e instanceof SignInNeeded ? 'signed-out' : `Could not read this folder: ${errorText(e)}`))
    return () => {
      current = false
    }
  }, [place, reload])

  const go = (next: Place) => {
    setBack([...back, place])
    setForward([])
    setPlace(next)
    setSelected(null)
    setRenaming(null)
    setMakingFolder(false)
    setFilter('')
  }

  const stepBack = () => {
    if (back.length === 0) return
    setForward([place, ...forward])
    setPlace(back[back.length - 1])
    setBack(back.slice(0, -1))
  }

  const stepForward = () => {
    if (forward.length === 0) return
    setBack([...back, place])
    setPlace(forward[0])
    setForward(forward.slice(1))
  }

  const goUp = () => {
    if (place.kind === 'folder' && place.path.length > 1) go({ kind: 'folder', path: place.path.slice(0, -1) })
  }

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
  const onDialogClose = () => {
    // The close event comes later than close(): by then the dialog may be back.
    if (!steppingAside.current && !dialogRef.current?.open) props.onClose()
  }

  const signedInToDrive = async () => isSignedIn() || (await props.onSignIn())

  const openWorkFolder = async (workFolder: WorkFolder) => {
    if (workFolder.folder.kind === 'drive' && !(await signedInToDrive())) return
    go({ kind: 'folder', path: [workFolder] })
  }

  const addWorkFolderOf = async (pickFolder: () => Promise<WorkFolder | null>) => {
    try {
      const picked = await pickFolder()
      if (!picked) return
      const added = await addWorkFolder(picked)
      setWorkFolders(savedWorkFolders())
      go({ kind: 'folder', path: [added] })
    } catch (e) {
      setProblem(`Could not add the folder: ${errorText(e)}`)
    }
  }

  const addLocalFolder = () =>
    addWorkFolderOf(async () => {
      const handle = await pickWorkFolder()
      return handle && { name: handle.name, folder: { kind: 'local', handle } }
    })

  const addDriveFolder = () =>
    addWorkFolderOf(async () => {
      if (!(await signedInToDrive())) return null
      const picked = await withDialogAside(pickDriveFolder)
      return picked && { name: picked.name, folder: { kind: 'drive', id: picked.id } }
    })

  const openDriveFile = async () => {
    try {
      if (!(await signedInToDrive())) return
      const picked = await withDialogAside(pickDriveFile)
      if (picked) props.onOpen({ kind: 'drive', fileId: picked.id, version: '' }, projectName(picked.name))
    } catch (e) {
      setProblem(`Could not open from Google Drive: ${errorText(e)}`)
    }
  }

  const forgetFolder = (workFolder: WorkFolder) => {
    removeWorkFolder(workFolder)
    setWorkFolders(savedWorkFolders())
    if (place.kind === 'folder' && place.path[0] === workFolder) setPlace({ kind: 'recent' })
  }

  const allowAccess = async () => {
    if (folder?.kind === 'local' && (await mayUseFolder(folder.handle, true))) setReload((n) => n + 1)
  }

  const shown = (entries ?? []).filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))
  const selectedEntry = shown.find((entry) => entry.fileName === selected)

  const activate = (entry: ExplorerEntry) => {
    if (entry.folder && place.kind === 'folder') return go({ kind: 'folder', path: [...place.path, { name: entry.name, folder: entry.folder }] })
    if (!entry.location) return
    if (mode === 'open') props.onOpen(entry.location, entry.name)
    else save(entry.name)
  }

  const save = async (saveName = name.trim()) => {
    if (!folder || !entries) return
    const trouble = nameProblem(saveName)
    if (trouble) return setProblem(trouble)
    const existing = entryNamed(entries, saveName, false)
    if (existing?.folder) return setProblem(`There is already a folder "${saveName}" here.`)
    if (existing && !(await confirm(`Replace "${saveName}"?`, 'A project with this name is already in this folder.', 'Replace'))) return
    props.onSave({ folder, name: saveName, existing })
  }

  /** Renames, or removes; neither for a document open in a tab, whose tab would lose track of it. */
  const blockedByTab = async (entry: ExplorerEntry) => {
    if (entry.location && (await props.isOpenInTab(entry.location))) {
      setProblem(`"${entry.name}" is open in a tab; close it first.`)
      return true
    }
    return false
  }

  const rename = async (entry: ExplorerEntry, newName: string) => {
    setRenaming(null)
    newName = newName.trim()
    if (!folder || !entries || newName === entry.name) return
    const trouble = nameProblem(newName)
    if (trouble) return setProblem(trouble)
    if (entryNamed(entries, newName, Boolean(entry.folder))) return setProblem(`There is already something called "${newName}" here.`)
    if (await blockedByTab(entry)) return
    try {
      await renameEntry(folder, entry, newName)
      setSelected(null)
      setReload((n) => n + 1)
    } catch (e) {
      setProblem(`Could not rename "${entry.name}": ${errorText(e)}`)
    }
  }

  const remove = async (entry: ExplorerEntry) => {
    if (!folder || (await blockedByTab(entry))) return
    const where = folder.kind === 'drive' ? 'It goes to the Google Drive trash.' : 'It is deleted from this computer for good.'
    const contents = entry.folder ? ' Everything in the folder goes with it.' : ''
    if (!(await confirm(`Delete "${entry.name}"?`, `${where}${contents}`, 'Delete'))) return
    try {
      await removeEntry(folder, entry)
      setSelected(null)
      setReload((n) => n + 1)
    } catch (e) {
      setProblem(`Could not delete "${entry.name}": ${errorText(e)}`)
    }
  }

  const createFolder = async (folderName: string) => {
    setMakingFolder(false)
    folderName = folderName.trim()
    if (!folder || !entries || !folderName) return
    const trouble = nameProblem(folderName)
    if (trouble) return setProblem(trouble)
    if (entryNamed(entries, folderName, true)) return setProblem(`There is already a folder "${folderName}" here.`)
    try {
      await makeFolder(folder, folderName)
      setReload((n) => n + 1)
    } catch (e) {
      setProblem(`Could not make the folder: ${errorText(e)}`)
    }
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (renaming || makingFolder || e.target instanceof HTMLInputElement) return
    if (e.key === 'Backspace') goUp()
    else if (selectedEntry && e.key === 'Enter') activate(selectedEntry)
    else if (selectedEntry && e.key === 'F2') setRenaming(selectedEntry.fileName)
    else if (selectedEntry && e.key === 'Delete') remove(selectedEntry)
    else return
    e.preventDefault()
  }

  const shownRoot = place.kind === 'folder' ? place.path[0] : null
  const pathText = place.kind === 'folder' ? place.path.map((crumb) => crumb.name).join(' › ') : 'Recent'

  return (
    <dialog ref={dialogRef} className="ai-dialog explorer" onClose={onDialogClose}>
      <header>
        <h2>
          <Icon name={mode === 'open' ? 'open' : 'save'} />
          {mode === 'open' ? 'Open project' : 'Save project'}
        </h2>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>

      <div className="explorer-body">
        <nav className="explorer-tree" aria-label="Places">
          <span className="explorer-heading">Quick access</span>
          <button className={place.kind === 'recent' ? 'active' : ''} onClick={() => go({ kind: 'recent' })}>
            <Icon name="clock" />Recent
          </button>
          <span className="explorer-heading">Workspaces</span>
          {workFolders.map((workFolder, k) => (
            <div key={k} className="explorer-tree-row">
              <button className={shownRoot === workFolder ? 'active' : ''} onClick={() => openWorkFolder(workFolder)} title={workFolder.name}>
                <Icon name={workFolder.folder.kind === 'drive' ? 'cloud' : 'folder'} />
                <span className="explorer-name">{workFolder.name}</span>
                <span className="explorer-kind">{workFolder.folder.kind === 'drive' ? 'Drive' : 'Local'}</span>
              </button>
              <button
                className="explorer-tree-remove"
                onClick={() => forgetFolder(workFolder)}
                title="Take this workspace off the list; the folder itself stays as it is"
                aria-label={`Remove workspace ${workFolder.name}`}
              >
                ✕
              </button>
            </div>
          ))}
          {(canUseFolders || driveConfigured) && (
            <button onClick={() => (canUseFolders && driveConfigured ? setChoosingWorkspace(!choosingWorkspace) : canUseFolders ? addLocalFolder() : addDriveFolder())}>
              <Icon name="folderPlus" />Add workspace…
            </button>
          )}
          {choosingWorkspace && (
            <div className="explorer-tree-choices">
              <button onClick={() => (setChoosingWorkspace(false), addLocalFolder())}>
                <Icon name="folder" />On this computer…
              </button>
              <button onClick={() => (setChoosingWorkspace(false), addDriveFolder())}>
                <Icon name="cloud" />In Google Drive…
              </button>
            </div>
          )}
          <hr />
          <span className="explorer-heading">Other locations</span>
          <button onClick={props.onOtherFile} title={mode === 'open' ? 'Open a file from anywhere on this computer' : 'Save to a file anywhere on this computer'}>
            <Icon name="file" />
            {mode === 'open' ? 'Open local file…' : canUseFolders ? 'Save as local file…' : 'Download'}
          </button>
          {driveConfigured && mode === 'open' && (
            <button onClick={openDriveFile} title="Pick a project anywhere in your Google Drive">
              <Icon name="cloud" />Browse Google Drive…
            </button>
          )}
        </nav>

        <section className="explorer-main">
          <div className="explorer-toolbar">
            <button className="icon-button" onClick={stepBack} disabled={back.length === 0} aria-label="Back"><Icon name="arrowLeft" /></button>
            <button className="icon-button" onClick={stepForward} disabled={forward.length === 0} aria-label="Forward"><Icon name="arrowRight" /></button>
            <button className="icon-button" onClick={goUp} disabled={place.kind !== 'folder' || place.path.length < 2} aria-label="Up"><Icon name="arrowUp" /></button>
            <div className="explorer-crumbs">
              {place.kind === 'recent' ? (
                <span>Recent</span>
              ) : (
                place.path.map((crumb, k) => (
                  <span key={k}>
                    {k > 0 && <Icon name="chevronRight" />}
                    <button onClick={() => k < place.path.length - 1 && go({ kind: 'folder', path: place.path.slice(0, k + 1) })}>
                      {k === 0 && <Icon name={crumb.folder.kind === 'drive' ? 'cloud' : 'folder'} />}
                      {crumb.name}
                    </button>
                  </span>
                ))
              )}
            </div>
            <input className="explorer-search" type="search" placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} disabled={!folder} />
          </div>
          <div className="explorer-actions">
            <button className="header-button" onClick={() => setMakingFolder(true)} disabled={!entries}>
              <Icon name="folderPlus" />New folder
            </button>
            <button className="header-button" onClick={() => selectedEntry && setRenaming(selectedEntry.fileName)} disabled={!selectedEntry || !folder} title="Rename (F2)">
              <Icon name="pencil" />Rename
            </button>
            <button className="header-button" onClick={() => selectedEntry && remove(selectedEntry)} disabled={!selectedEntry || !folder} title="Delete (Del)">
              <Icon name="trash" />Delete
            </button>
          </div>

          {problem && problem !== 'signed-out' && (
            <p className="explorer-problem" role="alert">
              {problem}
              <button className="icon-button" onClick={() => setProblem('')} aria-label="Dismiss">✕</button>
            </p>
          )}

          <div className="explorer-list" tabIndex={0} onKeyDown={onListKey}>
            <div className="explorer-row explorer-columns">
              <span>Name</span>
              <span>{place.kind === 'recent' ? 'Where' : 'Modified'}</span>
              <span>Size</span>
            </div>
            {place.kind === 'recent' ? (
              recent.length === 0 ? (
                <p className="explorer-empty">No recent projects yet.</p>
              ) : (
                recent.map((document, k) => (
                  <button
                    key={k}
                    className="explorer-row"
                    onClick={() => (mode === 'open' ? props.onOpen(document.location, document.name) : setName(document.name))}
                  >
                    <span className="explorer-name"><Icon name="app" />{document.name}</span>
                    <span>{locationLabel(document.location)}</span>
                    <span />
                  </button>
                ))
              )
            ) : needsPermission ? (
              <div className="explorer-empty">
                <p>The browser asks again whether the editor may use this folder.</p>
                <button className="header-button" onClick={allowAccess}>Allow access</button>
              </div>
            ) : problem === 'signed-out' ? (
              <div className="explorer-empty">
                <p>Google sign-in ran out.</p>
                <button className="header-button" onClick={() => props.onSignIn().then((ok) => ok && setReload((n) => n + 1))}>Sign in with Google</button>
              </div>
            ) : !entries ? (
              <p className="explorer-empty">Loading…</p>
            ) : (
              <>
                {makingFolder && (
                  <div className="explorer-row">
                    <span className="explorer-name">
                      <Icon name="folder" />
                      <NameInput initial="New folder" onDone={createFolder} onCancel={() => setMakingFolder(false)} />
                    </span>
                  </div>
                )}
                {shown.length === 0 && !makingFolder && (
                  <p className="explorer-empty">{filter ? 'Nothing matches the search.' : 'This folder is empty.'}</p>
                )}
                {folder?.kind === 'drive' && (
                  <p className="explorer-empty">
                    Google Drive shows the editor only the projects and folders it made here, and the files opened through
                    "File in Google Drive…".
                  </p>
                )}
                {shown.map((entry) => (
                  <div
                    key={entry.fileName}
                    className={entry.fileName === selected ? 'explorer-row selected' : 'explorer-row'}
                    onClick={() => {
                      setSelected(entry.fileName)
                      if (mode === 'save' && !entry.folder) setName(entry.name)
                    }}
                    onDoubleClick={() => activate(entry)}
                  >
                    <span className="explorer-name">
                      <Icon name={entry.folder ? 'folder' : 'app'} />
                      {renaming === entry.fileName ? (
                        <NameInput initial={entry.name} onDone={(newName) => rename(entry, newName)} onCancel={() => setRenaming(null)} />
                      ) : (
                        entry.name
                      )}
                    </span>
                    <span>{formatModified(entry.modified)}</span>
                    <span>{entry.folder ? '—' : formatSize(entry.size)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      </div>

      <footer className="explorer-footer">
        {mode === 'save' && (
          <label className="explorer-file-name">
            File name
            <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} autoFocus />
          </label>
        )}
        <div className="explorer-buttons">
          <span className="explorer-path">
            <Icon name={folder?.kind === 'drive' ? 'cloud' : place.kind === 'recent' ? 'clock' : 'folder'} />
            {pathText}
          </span>
          <button onClick={() => dialogRef.current?.close()}>Cancel</button>
          {mode === 'save' ? (
            <button className="primary" onClick={() => save()} disabled={!entries} title={entries ? undefined : 'Choose Google Drive or a work folder'}>
              <Icon name="save" />Save
            </button>
          ) : (
            <button className="primary" onClick={() => selectedEntry && activate(selectedEntry)} disabled={!selectedEntry}>
              <Icon name="open" />Open
            </button>
          )}
        </div>
      </footer>
    </dialog>
  )
}

/** Typing a name in place: Enter or leaving the field keeps it, Escape does not. */
function NameInput({ initial, onDone, onCancel }: { initial: string; onDone: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (keep: boolean) => {
    if (done.current) return
    done.current = true
    if (keep) onDone(value)
    else onCancel()
  }
  return (
    <input
      className="explorer-rename"
      value={value}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') {
          // Escape would close the whole dialog.
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
    />
  )
}
