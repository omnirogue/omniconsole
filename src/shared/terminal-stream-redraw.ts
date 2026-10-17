import {
  MAX_TAIL_LINES,
  MAX_TAIL_CHARS,
  clampTerminalPreviewCursor,
  trimTerminalLineRight,
  finalizeRetainedTerminalRows,
  type RetainedTailRedrawCursor,
  type RetainedTerminalRow
} from './terminal-stream-rows'
import { parseAnsiControlSequence, hasCanonicalNumericCsiParams } from './terminal-stream-controls'

// Why a window: the unwindowed impl below is O(tail) per chunk (~93% of the event loop under TUI flood, findings log 2026-07-03); a redraw only touches rows the cursor reaches, so window the suffix and share the prefix by reference. Equivalence fuzz-verified in retained-tail-redraw-window.equivalence.test.ts.
export const REDRAW_WINDOW_SAFETY_ROWS = 8

export function maxUpwardCursorReach(
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): number {
  let reach = previousRedrawCursor ? previousRedrawCursor.rowFromEnd : 0
  // eslint-disable-next-line no-control-regex -- Cursor-up escapes are literal terminal input.
  const cursorUpPattern = /\x1b\[(\d*)(?:;[\d;]*)?A/g
  let match: RegExpExecArray | null
  while ((match = cursorUpPattern.exec(normalizedChunk)) !== null) {
    reach += match[1] ? Number.parseInt(match[1], 10) : 1
  }
  return reach
}

export function appendNormalizedToMultilineTailBuffer(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const windowRows =
    maxUpwardCursorReach(normalizedChunk, previousRedrawCursor) + REDRAW_WINDOW_SAFETY_ROWS
  if (windowRows >= previousLines.length) {
    return appendNormalizedToMultilineTailBufferUnwindowed(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor
    )
  }
  const prefixLength = previousLines.length - windowRows
  const suffix = previousLines.slice(prefixLength)
  const windowed = appendNormalizedToMultilineTailBufferUnwindowed(
    suffix,
    boundedPreviousPartialLine,
    normalizedChunk,
    previousPartialWasCapped,
    previousRedrawCursor
  )
  let lines = previousLines.slice(0, prefixLength)
  // Why: the shared prefix must match the unwindowed finalize's trailing-space trim without paying a regex per untouched row.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const lastChar = line.charCodeAt(line.length - 1)
    if (lastChar === 32 || lastChar === 9) {
      lines[index] = line.replace(/[ \t]+$/g, '')
    }
  }
  for (const line of windowed.lines) {
    lines.push(line)
  }
  let truncated = windowed.truncated
  if (lines.length > MAX_TAIL_LINES) {
    lines = lines.slice(lines.length - MAX_TAIL_LINES)
    truncated = true
  }
  let totalChars = windowed.partialLine.length
  for (const line of lines) {
    totalChars += line.length
  }
  let dropCount = 0
  while (dropCount < lines.length && totalChars > MAX_TAIL_CHARS) {
    totalChars -= lines[dropCount]!.length
    dropCount += 1
  }
  if (dropCount > 0) {
    lines = lines.slice(dropCount)
    truncated = true
  }
  return {
    lines,
    partialLine: windowed.partialLine,
    redrawCursor: windowed.redrawCursor,
    truncated,
    newCompleteLines: windowed.newCompleteLines,
    newlyCompletedLines: windowed.newlyCompletedLines
  }
}

export function appendNormalizedToMultilineTailBufferUnwindowed(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const rows: RetainedTerminalRow[] = [
    ...previousLines.map((line) => ({ text: line, completed: true })),
    { text: boundedPreviousPartialLine, completed: false }
  ]
  let cursorRow = previousRedrawCursor
    ? Math.max(0, rows.length - 1 - previousRedrawCursor.rowFromEnd)
    : rows.length - 1
  let cursorColumn = previousRedrawCursor?.column ?? boundedPreviousPartialLine.length
  let newCompleteLines = 0
  const newlyCompletedLines: string[] = []
  let newlyCompletedLineCharacters = 0
  let newlyCompletedLineStart = 0
  let truncated = previousPartialWasCapped

  const retainNewlyCompletedLine = (line: string): void => {
    newlyCompletedLines.push(line)
    newlyCompletedLineCharacters += line.length
    while (
      newlyCompletedLines.length - newlyCompletedLineStart > MAX_TAIL_LINES ||
      newlyCompletedLineCharacters > MAX_TAIL_CHARS
    ) {
      newlyCompletedLineCharacters -= newlyCompletedLines[newlyCompletedLineStart]!.length
      newlyCompletedLineStart += 1
    }
    // Why: a single PTY chunk can carry unbounded newlines; compact in batches while retaining the suffix needed for stable pagination.
    if (newlyCompletedLineStart >= MAX_TAIL_LINES) {
      newlyCompletedLines.splice(0, newlyCompletedLineStart)
      newlyCompletedLineStart = 0
    }
  }

  const ensureCursorRow = (): void => {
    while (cursorRow >= rows.length) {
      rows.push({ text: '', completed: false })
    }
  }
  const trimRows = (): void => {
    const maxRows = MAX_TAIL_LINES + 1
    if (rows.length <= maxRows) {
      return
    }
    const removeCount = rows.length - maxRows
    rows.splice(0, removeCount)
    cursorRow = Math.max(0, cursorRow - removeCount)
    truncated = true
  }
  const moveCursorToColumn = (nextColumn: number): void => {
    cursorColumn = clampTerminalPreviewCursor(nextColumn)
  }
  const markCursorRowRewritten = (): void => {
    ensureCursorRow()
    rows[cursorRow]!.completed = false
  }
  const writeChar = (char: string): void => {
    ensureCursorRow()
    markCursorRowRewritten()
    const row = rows[cursorRow]!
    if (cursorColumn > row.text.length) {
      row.text = `${row.text}${' '.repeat(cursorColumn - row.text.length)}`
    }
    row.text =
      cursorColumn >= row.text.length
        ? `${row.text}${char}`
        : `${row.text.slice(0, cursorColumn)}${char}${row.text.slice(cursorColumn + 1)}`
    cursorColumn += 1
  }
  const eraseLine = (mode: number): void => {
    ensureCursorRow()
    markCursorRowRewritten()
    const row = rows[cursorRow]!
    if (mode === 0) {
      row.text = row.text.slice(0, cursorColumn)
    } else if (mode === 1) {
      const deleteCount = Math.min(cursorColumn + 1, row.text.length)
      row.text = `${' '.repeat(deleteCount)}${row.text.slice(deleteCount)}`
    } else if (mode === 2) {
      row.text = ''
    }
  }

  for (let index = 0; index < normalizedChunk.length; index += 1) {
    const char = normalizedChunk[index]
    if (char === '\n') {
      ensureCursorRow()
      rows[cursorRow]!.completed = true
      newCompleteLines += 1
      retainNewlyCompletedLine(trimTerminalLineRight(rows[cursorRow]!.text))
      cursorRow += 1
      cursorColumn = 0
      ensureCursorRow()
      trimRows()
      continue
    }
    if (char === '\r') {
      cursorColumn = 0
      continue
    }
    if (char === '\u0008') {
      cursorColumn = Math.max(0, cursorColumn - 1)
      continue
    }
    if (char === '\u001b') {
      const parsed = parseAnsiControlSequence(normalizedChunk, index)
      if (!parsed) {
        continue
      }
      index = parsed.endIndex
      if (parsed.kind !== 'csi' || !hasCanonicalNumericCsiParams(parsed.params)) {
        continue
      }
      const firstParam = parsed.firstParam ?? 1
      if (parsed.final === 'A') {
        cursorRow = Math.max(0, cursorRow - firstParam)
        rows.splice(cursorRow + 1)
      } else if (parsed.final === 'K') {
        eraseLine(parsed.firstParam ?? 0)
      } else if (parsed.final === 'G' || parsed.final === '`') {
        moveCursorToColumn(firstParam - 1)
      } else if (parsed.final === 'D') {
        cursorColumn = Math.max(0, cursorColumn - firstParam)
      } else if (parsed.final === 'C') {
        moveCursorToColumn(cursorColumn + firstParam)
      }
      continue
    }
    writeChar(char)
  }

  return finalizeRetainedTerminalRows(
    rows,
    cursorRow,
    cursorColumn,
    truncated,
    newCompleteLines,
    newlyCompletedLineStart > 0
      ? newlyCompletedLines.slice(newlyCompletedLineStart)
      : newlyCompletedLines
  )
}
