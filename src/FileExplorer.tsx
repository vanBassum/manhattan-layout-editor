import { useEffect, useRef, useState } from 'react'
import { errorText } from './errorText'
import {
  canUseFolders,
  driveRoot,
  entryNamed,
  listEntries,
  makeFolder,
  mayUseFolder,
  pickWorkFolder,
  removeEntry,
  renameEntry,
  type ExplorerEntry,
  type FolderRef,
} from './explorerStorage'
import { driveConfigured, isSignedIn, SignInNeeded } from './googleDrive'
import { Icon } from './panels'
import { addWorkFolder, removeWorkFolder, savedWorkFolders, type ProjectLocation, type RecentDocument } from './projectStore'

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

  const openDrive = async () => {
    if (!isSignedIn() && !(await props.onSignIn())) return
    try {
      go({ kind: 'folder', path: [{ name: 'Google Drive', folder: await driveRoot() }] })
    } catch (e) {
      setProblem(`Could not open Google Drive: ${errorText(e)}`)
    }
  }

  const openWorkFolder = (handle: FileSystemDirectoryHandle) => go({ kind: 'folder', path: [{ name: handle.name, folder: { kind: 'local', handle } }] })

  const addFolder = async () => {
    try {
      const handle = await pickWorkFolder()
      if (!handle) return
      await addWorkFolder(handle)
      setWorkFolders(savedWorkFolders())
      openWorkFolder(handle)
    } catch (e) {
      setProblem(`Could not add the folder: ${errorText(e)}`)
    }
  }

  const forgetFolder = (handle: FileSystemDirectoryHandle) => {
    removeWorkFolder(handle)
    setWorkFolders(savedWorkFolders())
    if (place.kind === 'folder' && place.path[0].folder.kind === 'local' && place.path[0].folder.handle === handle) setPlace({ kind: 'recent' })
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

  const isActiveRoot = (root: FolderRef | 'recent') => {
    if (root === 'recent') return place.kind === 'recent'
    if (place.kind !== 'folder') return false
    const shownRoot = place.path[0].folder
    return root.kind === 'drive' ? shownRoot.kind === 'drive' : shownRoot.kind === 'local' && shownRoot.handle === root.handle
  }

  const pathText = place.kind === 'folder' ? place.path.map((crumb) => crumb.name).join(' › ') : 'Recent'

  return (
    <dialog ref={dialogRef} className="ai-dialog explorer" onClose={props.onClose}>
      <header>
        <h2>
          <Icon name={mode === 'open' ? 'open' : 'save'} />
          {mode === 'open' ? 'Open project' : 'Save project'}
        </h2>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>

      <div className="explorer-body">
        <nav className="explorer-tree" aria-label="Places">
          <button className={isActiveRoot('recent') ? 'active' : ''} onClick={() => go({ kind: 'recent' })}>
            <Icon name="clock" />Recent
          </button>
          {driveConfigured && (
            <>
              <span className="explorer-heading">Storage</span>
              <button className={place.kind === 'folder' && place.path[0].folder.kind === 'drive' ? 'active' : ''} onClick={openDrive}>
                <Icon name="cloud" />Google Drive
              </button>
            </>
          )}
          <span className="explorer-heading">This computer</span>
          {workFolders.map((handle, k) => (
            <div key={k} className="explorer-tree-row">
              <button className={isActiveRoot({ kind: 'local', handle }) ? 'active' : ''} onClick={() => openWorkFolder(handle)} title={handle.name}>
                <Icon name="folder" />
                <span className="explorer-name">{handle.name}</span>
              </button>
              <button className="explorer-tree-remove" onClick={() => forgetFolder(handle)} title="Take this folder off the list; it stays on disk" aria-label={`Forget ${handle.name}`}>
                ✕
              </button>
            </div>
          ))}
          {canUseFolders && (
            <button onClick={addFolder} title="Pick a folder on this computer to keep projects in">
              <Icon name="folderPlus" />Add work folder…
            </button>
          )}
          <button onClick={props.onOtherFile} title={mode === 'open' ? 'Open a file from anywhere on this computer' : 'Save to a file anywhere on this computer'}>
            <Icon name="file" />
            {mode === 'open' ? 'Other file…' : canUseFolders ? 'Other location…' : 'Download'}
          </button>
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
