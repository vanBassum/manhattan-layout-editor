import { describe, expect, it } from 'vitest'
import { shortcutAction, type KeyPress } from './shortcuts'

const press = (key: string, modifiers: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({ key, command: false, shift: false, typing: false, ...modifiers })

describe('shortcutAction', () => {
  it('maps Ctrl/Cmd keys to file and edit actions', () => {
    expect(shortcutAction(press('s', { command: true }))).toBe('save')
    expect(shortcutAction(press('S', { command: true, shift: true }))).toBe('saveAs')
    expect(shortcutAction(press('o', { command: true }))).toBe('open')
    expect(shortcutAction(press('n', { command: true }))).toBe('newProject')
    expect(shortcutAction(press('z', { command: true }))).toBe('undo')
    expect(shortcutAction(press('Z', { command: true, shift: true }))).toBe('redo')
    expect(shortcutAction(press('y', { command: true }))).toBe('redo')
    expect(shortcutAction(press('a', { command: true }))).toBe('selectAll')
    expect(shortcutAction(press('q', { command: true }))).toBeUndefined()
  })

  it('keeps only the file shortcuts while typing, so undo and select-all stay with the field', () => {
    expect(shortcutAction(press('s', { command: true, typing: true }))).toBe('save')
    expect(shortcutAction(press('z', { command: true, typing: true }))).toBeUndefined()
    expect(shortcutAction(press('a', { command: true, typing: true }))).toBeUndefined()
    expect(shortcutAction(press('v', { typing: true }))).toBeUndefined()
    expect(shortcutAction(press(' ', { typing: true }))).toBeUndefined()
  })

  it('maps plain keys to canvas actions, in either case', () => {
    expect(shortcutAction(press(' '))).toBe('rotate')
    expect(shortcutAction(press(' ', { shift: true }))).toBe('rotateFine')
    expect(shortcutAction(press('Delete'))).toBe('removeRect')
    expect(shortcutAction(press('Backspace'))).toBe('removeRect')
    expect(shortcutAction(press('Escape'))).toBe('clearSelection')
    expect(shortcutAction(press('F'))).toBe('fit')
    expect(shortcutAction(press('v'))).toBe('selectTool')
    expect(shortcutAction(press('w'))).toBe('wireTool')
    expect(shortcutAction(press('l'))).toBe('labelTool')
    expect(shortcutAction(press('h'))).toBe('panTool')
    expect(shortcutAction(press('x'))).toBe('flipHorizontal')
    expect(shortcutAction(press('y'))).toBe('flipVertical')
    expect(shortcutAction(press('m'))).toBe('toggleMoveMode')
    expect(shortcutAction(press('q'))).toBeUndefined()
  })
})
