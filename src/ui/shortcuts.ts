import { useEffect, useRef } from 'react'

export type ShortcutAction =
  | 'save'
  | 'saveAs'
  | 'open'
  | 'newProject'
  | 'undo'
  | 'redo'
  | 'selectAll'
  | 'rotate'
  | 'rotateFine'
  | 'removeRect'
  | 'clearSelection'
  | 'fit'
  | 'selectTool'
  | 'wireTool'
  | 'labelTool'
  | 'panTool'
  | 'flipHorizontal'
  | 'flipVertical'
  | 'toggleMoveMode'

export interface KeyPress {
  /** `KeyboardEvent.key`, in any case. */
  key: string
  /** Ctrl, or Cmd on a Mac. */
  command: boolean
  shift: boolean
  /** The key goes to a text field or drop-down. */
  typing: boolean
}

/** The action a key press asks for, if any. */
export function shortcutAction({ key, command, shift, typing }: KeyPress): ShortcutAction | undefined {
  const lowerKey = key.toLowerCase()
  if (command) return commandAction(lowerKey, shift, typing)
  if (typing) return undefined
  return plainAction(lowerKey, shift)
}

/** The file shortcuts also work while typing in a field, instead of the browser's own. */
function commandAction(key: string, shift: boolean, typing: boolean): ShortcutAction | undefined {
  switch (key) {
    case 's':
      return shift ? 'saveAs' : 'save'
    case 'o':
      return 'open'
    case 'n':
      return 'newProject'
  }
  if (typing) return undefined
  switch (key) {
    case 'z':
      return shift ? 'redo' : 'undo'
    case 'y':
      return 'redo'
    case 'a':
      return 'selectAll'
  }
}

function plainAction(key: string, shift: boolean): ShortcutAction | undefined {
  switch (key) {
    case ' ':
      return shift ? 'rotateFine' : 'rotate'
    case 'delete':
    case 'backspace':
      return 'removeRect'
    case 'escape':
      return 'clearSelection'
    case 'f':
      return 'fit'
    case 'v':
      return 'selectTool'
    case 'w':
      return 'wireTool'
    case 'l':
      return 'labelTool'
    case 'h':
      return 'panTool'
    case 'x':
      return 'flipHorizontal'
    case 'y':
      return 'flipVertical'
    case 'm':
      return 'toggleMoveMode'
  }
}

/** Runs the handler of each shortcut pressed anywhere in the window. */
export function useShortcuts(handlers: Record<ShortcutAction, () => void>) {
  // The handlers are new on every render; the listener reads the latest so they always see current state.
  const latestHandlers = useRef(handlers)
  latestHandlers.current = handlers
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // An open dialog handles its own keys (Escape closes it); the canvas shortcuts stay out of the way.
      if (e.target instanceof Element && e.target.closest('dialog')) return
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement
      const command = e.ctrlKey || e.metaKey
      const action = shortcutAction({ key: e.key, command, shift: e.shiftKey, typing })
      if (!action) return
      const rotates = action === 'rotate' || action === 'rotateFine'
      // A command key replaces the browser's own; Space would also click a focused button.
      if (command || rotates) e.preventDefault()
      // Holding Space turns the part once, not on every repeat.
      if (rotates && e.repeat) return
      latestHandlers.current[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
