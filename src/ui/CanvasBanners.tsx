import type { ProjectFile } from '../documents/projectStore'
import { Icon } from './icons'
import type { FileConflict } from './useDocuments'

interface CanvasBannersProps {
  error: string
  onDismissError: () => void
  notice: string
  onDismissNotice: () => void
  /** The shown tab's name and saved file. */
  tabName: string
  file: ProjectFile
  /** A conflict about the shown tab's file, if there is one. */
  conflict: FileConflict | undefined
  onUseSavedVersion: (conflict: FileConflict) => void
  onKeepChangesHere: (conflict: FileConflict) => void
  /** Compares the recovery copy with the saved file, asking for access first. */
  onCheckSaved: () => void
  pinsNotInPcb: string[]
  onUpdatePcb: () => void
}

/** Messages floating over the canvas: a banner that pushed the canvas down would move it under a drag. */
export function CanvasBanners(props: CanvasBannersProps) {
  const { error, notice, tabName, file, conflict, pinsNotInPcb } = props
  return (
    <div className="canvas-banners">
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
          <button className="icon-button" onClick={props.onDismissError} aria-label="Dismiss">✕</button>
        </div>
      )}
      {notice && (
        <div className="banner banner-ok" role="status">
          {notice}
          <button className="icon-button" onClick={props.onDismissNotice} aria-label="Dismiss">✕</button>
        </div>
      )}
      {conflict ? (
        <div className="banner banner-warn" role="alert">
          <span>
            "{tabName}" changed {file.location?.kind === 'drive' ? 'in Google Drive' : 'on disk'},
            and this tab has changes that were not saved.
          </span>
          <button className="header-button" onClick={() => props.onUseSavedVersion(conflict)} title="Show the saved version; the changes here stay reachable with Undo">
            Use saved version
          </button>
          <button className="header-button" onClick={() => props.onKeepChangesHere(conflict)} title="Keep editing the changes here; saving overwrites the saved version">
            Keep changes here
          </button>
        </div>
      ) : (
        file.location &&
        !file.checked && (
          <div className="banner banner-warn" role="status">
            {file.location.kind === 'drive' ? (
              <>
                <span>Showing the recovery copy of "{tabName}"; sign in to compare it with Google Drive and save it there.</span>
                <button className="header-button" onClick={props.onCheckSaved}>
                  <Icon name="cloud" />Sign in to Google Drive
                </button>
              </>
            ) : (
              <>
                <span>Showing the recovery copy of "{tabName}"; the file itself was not checked yet.</span>
                <button className="header-button" onClick={props.onCheckSaved} title="Allow access to the file and compare it with the recovery copy">
                  <Icon name="open" />Check file
                </button>
              </>
            )}
          </div>
        )
      )}
      {pinsNotInPcb.length > 0 && (
        <div className="banner banner-warn" role="status">
          <span title={pinsNotInPcb.join(' ')}>
            The schematic has changes the PCB does not have yet: {pinsNotInPcb.length} pin{pinsNotInPcb.length === 1 ? '' : 's'} connected differently.
          </span>
          <button className="header-button" onClick={props.onUpdatePcb} title="Give the PCB the schematic's nets; islands follow renamed and merged nets (can be undone)">
            <Icon name="convert" />Update PCB
          </button>
        </div>
      )}
    </div>
  )
}
