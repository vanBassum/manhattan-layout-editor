import { useEffect, useRef, useState } from 'react'
import { listDriveDocuments } from './driveDocuments'
import { errorText } from './errorText'
import { driveConfigured, type DriveDocument } from './googleDrive'
import { Icon } from './panels'
import type { RecentDocument } from './projectStore'

interface OpenDialogProps {
  signedIn: boolean
  recent: RecentDocument[]
  onSignIn: () => void
  onOpenDrive: (fileId: string) => void
  onOpenLocal: () => void
  onOpenRecent: (recent: RecentDocument) => void
  onClose: () => void
}

const modified = (document: DriveDocument) =>
  new Date(document.modifiedTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The projects in Google Drive, while signed in. */
function DriveDocuments({ onOpen }: { onOpen: (fileId: string) => void }) {
  const [documents, setDocuments] = useState<DriveDocument[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    listDriveDocuments().then(setDocuments, (e) => setError(`Could not list the documents: ${errorText(e)}`))
  }, [])

  if (error) return <p className="badge error">{error}</p>
  if (!documents) return <p className="open-empty">Loading…</p>
  if (documents.length === 0) return <p className="open-empty">No projects saved in Google Drive yet.</p>
  return (
    <ul className="open-list">
      {documents.map((document) => (
        <li key={document.id}>
          <button onClick={() => onOpen(document.id)}>
            <Icon name="cloud" />
            <span className="open-name">{document.name}</span>
            <span className="open-detail">{modified(document)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Open a project: from Google Drive, from this computer, or one of the recent documents. */
export function OpenDialog({ signedIn, recent, onSignIn, onOpenDrive, onOpenLocal, onOpenRecent, onClose }: OpenDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])

  return (
    <dialog ref={dialogRef} className="ai-dialog open-dialog" onClose={onClose}>
      <header>
        <h2><Icon name="open" />Open a project</h2>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>

      {driveConfigured && (
        <section>
          <h3><Icon name="cloud" />Google Drive</h3>
          {signedIn ? (
            <DriveDocuments onOpen={onOpenDrive} />
          ) : (
            <button className="header-button" onClick={onSignIn}>Sign in with Google to see your projects</button>
          )}
        </section>
      )}

      <section>
        <h3><Icon name="file" />This computer</h3>
        <button className="header-button" onClick={onOpenLocal}>
          <Icon name="open" />Open a file…
        </button>
      </section>

      {recent.length > 0 && (
        <section>
          <h3>Recent</h3>
          <ul className="open-list">
            {recent.map((document, k) => (
              <li key={k}>
                <button onClick={() => onOpenRecent(document)}>
                  <Icon name={document.location.kind === 'drive' ? 'cloud' : 'file'} />
                  <span className="open-name">{document.name}</span>
                  <span className="open-detail">{document.location.kind === 'drive' ? 'Google Drive' : 'This computer'}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </dialog>
  )
}
