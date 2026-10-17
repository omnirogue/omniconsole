import type { Terminal } from '@xterm/xterm'

export function readTerminalCurrentScreenText(terminal: Pick<Terminal, 'buffer' | 'rows'>): string {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  // Serialization replaces blank cells with cursor moves; detectors need the actual spacing.
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row)
    const continues = buffer.getLine(buffer.baseY + row + 1)?.isWrapped === true
    // Why keep a wrapped row's full width: a soft wrap after "…I " must read back as one
    // logical line with its space, or the trust prompt's selected option is misread.
    const text = line?.translateToString(!continues) ?? ''
    if (line?.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text
    } else {
      lines.push(text)
    }
  }
  return lines.join('\n')
}
