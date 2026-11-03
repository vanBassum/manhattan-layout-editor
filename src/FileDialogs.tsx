import { useEffect, useRef, useState } from 'react'
import { driveConfigured } from './googleDrive'
import { Icon, type IconName } from './panels'
import type { ProjectLocation, RecentDocument } from './projectStore'

const PLACES: Record<ProjectLocation['kind'], { icon: IconName; label: string; open: string; save: string }> = {
  local: { icon: 'computer', label: 'This computer', open: 'Open a file from your computer', save: 'Choose a location on your computer' },
  drive: { icon: 'cloud', label: 'Google Drive', open: 'Open a file from your Google Drive', save: 'Save in the folder Manhattan Layout Editor' },
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
  /** Where Enter saves: where the project is now, or this computer. */
  place: ProjectLocation['kind']
  onDone: (choice: SaveChoice | null) => void
}

/** Save as: a name, then a tile for this computer or Google Drive, whose own picker chooses the folder. */
export function SaveAsDialog({ name: initialName, place: enterPlace, onDone }: SaveAsDialogProps) {
  const dialogRef = useModal()
  const [name, setName] = useState(initialName)
  const trimmed = name.trim()
  const save = (place: ProjectLocation['kind']) => trimmed && onDone({ name: trimmed, place })

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
          onKeyDown={(e) => e.key === 'Enter' && save(enterPlace)}
          onFocus={(e) => e.target.select()}
          autoFocus
        />
      </label>
      <div className="file-places">
        {placesShown().map((place) => (
          <button key={place} className="file-place" onClick={() => save(place)} disabled={!trimmed}>
            <Icon name={PLACES[place].icon} />
            <span>
              <strong>{PLACES[place].label}…</strong>
              <small>{PLACES[place].save}</small>
            </span>
          </button>
        ))}
      </div>
    </dialog>
  )
}
