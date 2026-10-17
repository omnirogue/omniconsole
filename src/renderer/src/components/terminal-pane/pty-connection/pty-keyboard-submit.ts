/**
 * Why: session prep diverts a terminal prompt only when the person submitted it themselves. This sees
 * xterm's input path alone, so programmatic writes (startup commands, queued input, agent sends) never
 * reach it. It rebuilds the typed line so a prompt Claude delivers later (typed mid-turn) still matches.
 */
import { skipTerminalEscape } from '../../../../../shared/terminal-typed-input'

export { isTypedTerminalInput } from '../../../../../shared/terminal-typed-input'

const MAX_LINE_CHARS = 8_000
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

type TypedLine = { text: string; inPaste: boolean }
const typedLineByPtyId = new Map<string, TypedLine>()

function applyControl(line: TypedLine, char: string): void {
  if (char === '\x7f' || char === '\b') {
    line.text = line.text.slice(0, -1)
  } else if (char === '\x15' || char === '\x03') {
    line.text = ''
  } else if (char === '\x17') {
    line.text = line.text.replace(/\S+\s*$/, '')
  } else if (char >= ' ' || char === '\t') {
    line.text += char
  }
}

export function noteTerminalKeyboardInput(ptyId: string | null, data: string): void {
  if (!ptyId) {
    return
  }
  const line = typedLineByPtyId.get(ptyId) ?? { text: '', inPaste: false }
  let index = 0
  while (index < data.length) {
    if (data.startsWith(PASTE_START, index) || data.startsWith(PASTE_END, index)) {
      line.inPaste = data.startsWith(PASTE_START, index)
      index += PASTE_START.length
      continue
    }
    const char = data[index]!
    if (char === '\x1b' && data[index + 1] === '\r') {
      // Why: ESC+Enter is the TUI's newline, not a submit.
      line.text += '\n'
      index += 2
    } else if (char === '\x1b') {
      index = skipTerminalEscape(data, index)
    } else if ((char === '\r' || char === '\n') && line.inPaste) {
      line.text += '\n'
      index += 1
    } else if (char === '\r' || char === '\n') {
      window.api.pty.noteKeyboardSubmit?.(ptyId, line.text.slice(-MAX_LINE_CHARS))
      line.text = ''
      index += 1
    } else {
      applyControl(line, char)
      index += 1
    }
  }
  if (line.text.length > MAX_LINE_CHARS * 2) {
    line.text = line.text.slice(-MAX_LINE_CHARS)
  }
  typedLineByPtyId.set(ptyId, line)
}
