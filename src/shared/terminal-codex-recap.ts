/** Inclusive indexes into the exact screen lines accompanying this owner-produced evidence. */
export type TerminalScreenDecoration = {
  kind: 'codex-recap'
  startRow: number
  endRow: number
}

type RecapCell = {
  getChars(): string
  getWidth(): number
  isDim(): boolean | number
  isItalic(): boolean | number
  isBold(): boolean | number
}

type RecapLine = {
  readonly isWrapped: boolean
  getCell(column: number): RecapCell | undefined
  translateToString(trimRight?: boolean): string
}

export type CodexRecapCellSource = {
  readonly cols: number
  readonly rows: number
  readonly buffer: {
    readonly active: {
      readonly viewportY: number
      getLine(row: number): RecapLine | undefined
    }
  }
}

const PREFIX = '  ↳ Recap: '
const INDENT = PREFIX.length

function hasRecapStyle(line: RecapLine, cols: number, boldStart = -1, boldLength = 0): boolean {
  if (line.isWrapped !== false) {
    return false
  }
  let visible = false
  for (let col = 0; col < cols; col += 1) {
    const cell = line.getCell(col)
    if (!cell) {
      return false
    }
    if (cell.getWidth() === 0 || !cell.getChars().trim()) {
      continue
    }
    visible = true
    if (col + cell.getWidth() > cols - 2 || !cell.isDim() || !cell.isItalic()) {
      return false
    }
    if (Boolean(cell.isBold()) !== (col >= boldStart && col < boldStart + boldLength)) {
      return false
    }
  }
  return visible
}

function boldLabel(line: RecapLine, start: number, length: number): boolean {
  for (let col = start; col < start + length; col += 1) {
    if (!line.getCell(col)?.isBold()) {
      return false
    }
  }
  return true
}

function boundedBody(rows: { line: RecapLine; text: string }[]): boolean {
  const summary: string[] = []
  const next: string[] = []
  let inNext = false
  for (const [index, { line, text }] of rows.entries()) {
    const body = text.slice(INDENT)
    if (body.startsWith('Next: ') && boldLabel(line, INDENT, 5)) {
      if (index === 0 || inNext) {
        return false
      }
      inNext = true
      next.push(body.slice(6))
    } else {
      ;(inNext ? next : summary).push(body)
    }
  }
  const summaryLength = [...summary.join(' ')].length
  const nextLength = [...next.join(' ')].length
  return (
    summaryLength > 0 && summaryLength <= 700 && nextLength <= 200 && (!inNext || nextLength > 0)
  )
}

/** Codex 0.157.1 notices.rs: italic arrow, bold label, dim body and an eleven-cell hanging indent. */
export function readCodexRecapDecorations(
  terminal: CodexRecapCellSource,
  visibleLines?: readonly string[]
): TerminalScreenDecoration[] {
  if (
    !Number.isInteger(terminal.cols) ||
    terminal.cols <= INDENT + 2 ||
    !Number.isInteger(terminal.rows) ||
    terminal.rows < 1
  ) {
    return []
  }
  const buffer = terminal.buffer.active
  const decorations: TerminalScreenDecoration[] = []
  for (let row = 0; row < terminal.rows; row += 1) {
    const first = buffer.getLine(buffer.viewportY + row)
    const text = visibleLines?.[row] ?? first?.translateToString(true) ?? ''
    if (!first || !text.startsWith(PREFIX) || !/^\S/.test(text.slice(INDENT))) {
      continue
    }
    if (first.translateToString(true) !== text) {
      continue
    }
    if (!hasRecapStyle(first, terminal.cols, 4, 6) || !boldLabel(first, 4, 6)) {
      continue
    }
    const body = [{ line: first, text }]
    let endRow = row
    let valid = true
    for (let nextRow = row + 1; nextRow < terminal.rows; nextRow += 1) {
      const line = buffer.getLine(buffer.viewportY + nextRow)
      const nextText = visibleLines?.[nextRow] ?? line?.translateToString(true) ?? ''
      if (!/^ {11}\S/.test(nextText)) {
        break
      }
      const nextLabel =
        line && nextText.slice(INDENT).startsWith('Next: ') && boldLabel(line, INDENT, 5)
      if (
        !line ||
        line.translateToString(true) !== nextText ||
        !hasRecapStyle(line, terminal.cols, nextLabel ? INDENT : -1, nextLabel ? 5 : 0)
      ) {
        valid = false
        break
      }
      body.push({ line, text: nextText })
      endRow = nextRow
    }
    const following = buffer.getLine(buffer.viewportY + endRow + 1)
    if (
      valid &&
      endRow < terminal.rows - 1 &&
      following &&
      !following.translateToString(true).trim() &&
      boundedBody(body)
    ) {
      decorations.push({ kind: 'codex-recap', startRow: row, endRow })
    }
    row = endRow
  }
  return decorations
}

/** Removed or clipped rows revoke the entire block; equal text elsewhere cannot relocate it. */
export function remapTerminalScreenDecorations(
  decorations: readonly TerminalScreenDecoration[] | undefined,
  retainedRows: readonly number[]
): TerminalScreenDecoration[] {
  const mapped: TerminalScreenDecoration[] = []
  for (const decoration of decorations ?? []) {
    if (
      decoration.kind !== 'codex-recap' ||
      !Number.isInteger(decoration.startRow) ||
      !Number.isInteger(decoration.endRow) ||
      decoration.startRow < 0 ||
      decoration.endRow < decoration.startRow
    ) {
      continue
    }
    const startRow = retainedRows.indexOf(decoration.startRow)
    const count = decoration.endRow - decoration.startRow + 1
    if (startRow === -1 || count > retainedRows.length - startRow) {
      continue
    }
    if (
      !retainedRows
        .slice(startRow, startRow + count)
        .every((row, index) => row === decoration.startRow + index)
    ) {
      continue
    }
    mapped.push({ kind: decoration.kind, startRow, endRow: startRow + count - 1 })
  }
  return mapped
}
