import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteTerminalKeyboardInput } from './pty-keyboard-submit'

describe('noteTerminalKeyboardInput', () => {
  const noteKeyboardSubmit = vi.fn()

  beforeEach(() => {
    noteKeyboardSubmit.mockReset()
    vi.stubGlobal('window', { api: { pty: { noteKeyboardSubmit } } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const type = (ptyId: string, ...chunks: string[]) => {
    for (const chunk of chunks) {
      noteTerminalKeyboardInput(ptyId, chunk)
    }
  }

  it('reports the typed line on Enter, applying backspace', () => {
    type('pty-a', 'c', 'r', 'e', 'x', '\x7f', 'ate sessions', '\r')
    expect(noteKeyboardSubmit).toHaveBeenCalledWith('pty-a', 'create sessions')
  })

  it('keeps pasted newlines and TUI newlines inside the line', () => {
    type('pty-b', '\x1b[200~line one\rline two\x1b[201~', ' end', '\x1b\r', 'more', '\r')
    expect(noteKeyboardSubmit).toHaveBeenCalledWith('pty-b', 'line one\nline two end\nmore')
  })

  it('drops arrow keys, clears on Ctrl+U and tracks each pty separately', () => {
    type('pty-c', 'abc', '\x1b[D', '\x15', 'fresh')
    type('pty-d', 'other', '\r')
    type('pty-c', '\r')
    expect(noteKeyboardSubmit).toHaveBeenNthCalledWith(1, 'pty-d', 'other')
    expect(noteKeyboardSubmit).toHaveBeenNthCalledWith(2, 'pty-c', 'fresh')
  })

  it('ignores input without a pty', () => {
    noteTerminalKeyboardInput(null, 'x\r')
    expect(noteKeyboardSubmit).not.toHaveBeenCalled()
  })
})
