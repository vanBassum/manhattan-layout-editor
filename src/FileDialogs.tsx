import { useEffect, useRef, useState } from 'react'
import { driveConfigured } from './googleDrive'
import { Icon, type IconName } from './panels'
import type { ProjectLocation, RecentDocument } from './projectStore'

const PLACES: Record<ProjectLocation['kind'], { icon: IconName; label: string; open: string; save: string }> = {
  local: { icon: 'computer', label: 'This computer', open: 'Open a file from your computer', save: 'Choose a location on your computer' },
  drive: { icon: 'cloud', label: 'Google Drive', open: 'Open a file from your Google Drive', save: 'Choose a folder in Google Drive' },
}

const placesShown = (): ProjectLocation['kind'][] => (driveConfigured ? ['local', 'drive'] : ['local'])

/** A modal dialog that is shown as soon as it mounts. */
function useModal() {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])
  return dialogRef
}

interface OpenDialogProps {
  recent: RecentDocument[]
  onOpenRecent: (recent: RecentDocument) => void
  onOpenFrom: (place: ProjectLocation['kind']) => void
  onClose: () => void
}

/** Open: a recent project, or one from this computer or Google Drive through their own file pickers. */
export function OpenDialog({ recent, onOpenRecent, onOpenFrom, onClose }: OpenDialogProps) {
  const dialogRef = useModal()
  return (
    <dialog ref={dialogRef} className="ai-dialog file-dialog" onClose={onClose}>
      <header>
        <h2><Icon name="open" />Open project</h2>
        <button className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close">✕</button>
      </header>
      {recent.length > 0 && (
        <section className="file-recent">
          <h3><Icon name="clock" />Recent</h3>
          {recent.map((document, k) => (
            <button key={k} onClick={() => onOpenRecent(document)}>
              <Icon name={PLACES[document.location.kind].icon} />
              <span className="file-recent-name">{document.name}</span>
              <span className="file-recent-place">({PLACES[document.location.kind].label})</span>
            </button>
          ))}
        </section>
      )}
      <div className="file-places">
        {placesShown().map((place) => (
          <button key={place} className="file-place" onClick={() => onOpenFrom(place)}>
            <Icon name={PLACES[place].icon} />
            <span>
              <strong>{PLACES[place].label}…</strong>
              <small>{PLACES[place].open}</small>
            </span>
          </button>
        ))}
      </div>
    </dialog>
  )
}

export interface SaveChoice {
  name: string
  place: ProjectLocation['kind']
}

interface SaveAsDialogProps {
  name: string
  /** The place picked first: where the project is now, or this computer. */
  place: ProjectLocation['kind']
  onDone: (choice: SaveChoice | null) => void
}

/** Save as: a name, and whether it goes to this computer or Google Drive; their own pickers choose the folder. */
export function SaveAsDialog({ name: initialName, place: initialPlace, onDone }: SaveAsDialogProps) {
  const dialogRef = useModal()
  const [name, setName] = useState(initialName)
  const [place, setPlace] = useState(initialPlace)
  const trimmed = name.trim()
  const save = () => trimmed && onDone({ name: trimmed, place })

  return (
    <dialog ref={dialogRef} className="ai-dialog file-dialog" onCancel={() => onDone(null)}>
      <header>
        <h2><Icon name="save" />Save project as</h2>
        <button className="icon-button" onClick={() => onDone(null)} aria-label="Close">✕</button>
      </header>
      <label className="file-name">
        File name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          onFocus={(e) => e.target.select()}
          autoFocus
        />
      </label>
      <div className="file-places" role="radiogroup" aria-label="Save to">
        {placesShown().map((option) => (
          <button
            key={option}
            role="radio"
            aria-checked={place === option}
            className={place === option ? 'file-place selected' : 'file-place'}
            onClick={() => setPlace(option)}
            onDoubleClick={() => trimmed && onDone({ name: trimmed, place: option })}
          >
            <Icon name={PLACES[option].icon} />
            <span>
              <strong>{PLACES[option].label}…</strong>
              <small>{PLACES[option].save}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="dialog-actions">
        <button onClick={() => onDone(null)}>Cancel</button>
        <button className="primary" onClick={save} disabled={!trimmed}>
          <Icon name="save" />Save
        </button>
      </div>
    </dialog>
  )
}
