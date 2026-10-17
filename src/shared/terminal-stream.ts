import { MAX_TAIL_LINES, MAX_TAIL_CHARS, MAX_TAIL_PARTIAL_CHARS } from './terminal-stream-rows'
import { normalizeTerminalChunk } from './terminal-stream-controls'
import {
  appendCompletedTerminalTranscript,
  appendNormalizedToTailBuffer
} from './terminal-stream-tail'
import type { RetainedTailRedrawCursor } from './terminal-stream-rows'

export { normalizeTerminalChunk } from './terminal-stream-controls'
export {
  appendCompletedTerminalTranscript,
  appendNormalizedToTailBuffer
} from './terminal-stream-tail'
export { appendNormalizedToMultilineTailBufferUnwindowed } from './terminal-stream-redraw'
export {
  MAX_TAIL_LINES,
  MAX_TAIL_CHARS,
  MAX_TAIL_PARTIAL_CHARS,
  type RetainedTailRedrawCursor
} from './terminal-stream-rows'

export type TerminalStreamSnapshot = {
  version: 1
  lines: string[]
  previewLines: string[]
  partialLine: string
  completedLineCount: number
  truncated: boolean
}

export class BoundedTerminalStream {
  private lines: string[] = []
  private previewLines: string[] = []
  private characters = 0
  private partialLine = ''
  private pendingAnsi = ''
  private redrawCursor: RetainedTailRedrawCursor | null = null
  private completedLineCount = 0
  private truncated = false
  private finished = false

  append(chunk: string): void {
    if (this.finished) {
      return
    }
    const normalized = normalizeTerminalChunk(chunk, this.pendingAnsi)
    this.pendingAnsi = normalized.pendingAnsi
    const tail = appendNormalizedToTailBuffer(
      this.previewLines,
      this.partialLine,
      normalized.text,
      this.redrawCursor
    )
    const transcript = appendCompletedTerminalTranscript(
      this.lines,
      this.characters,
      tail.newlyCompletedLines,
      tail.newCompleteLines
    )
    this.lines = transcript.lines
    this.characters = transcript.characters
    this.previewLines = tail.lines
    this.partialLine = tail.partialLine
    this.redrawCursor = tail.redrawCursor
    this.completedLineCount += tail.newCompleteLines
    this.truncated ||= tail.truncated || transcript.truncated
  }

  finish(): void {
    if (this.finished) {
      return
    }
    if (this.partialLine.length > 0) {
      // EOF commits the retained draft; a dangling escape cannot absorb its terminator.
      this.pendingAnsi = ''
      this.redrawCursor = null
      this.append('\n')
    }
    this.finished = true
  }

  snapshot(): TerminalStreamSnapshot {
    return {
      version: 1,
      lines: [...this.lines],
      previewLines: [...this.previewLines],
      partialLine: this.partialLine,
      completedLineCount: this.completedLineCount,
      truncated: this.truncated
    }
  }
}

export function createBoundedTerminalStream(): BoundedTerminalStream {
  return new BoundedTerminalStream()
}

export function parseTerminalStreamSnapshot(value: unknown): TerminalStreamSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const stream = value as Record<string, unknown>
  if (
    stream.version !== 1 ||
    typeof stream.partialLine !== 'string' ||
    stream.partialLine.length > MAX_TAIL_PARTIAL_CHARS ||
    !Number.isSafeInteger(stream.completedLineCount) ||
    typeof stream.truncated !== 'boolean'
  ) {
    return null
  }
  const lines = parseStreamLines(stream.lines, MAX_TAIL_CHARS)
  const previewLines = parseStreamLines(
    stream.previewLines,
    MAX_TAIL_CHARS - stream.partialLine.length
  )
  if (!lines || !previewLines || Number(stream.completedLineCount) < lines.length) {
    return null
  }
  return {
    version: 1,
    lines,
    previewLines,
    partialLine: stream.partialLine,
    completedLineCount: Number(stream.completedLineCount),
    truncated: stream.truncated
  }
}

function parseStreamLines(value: unknown, maximumChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_TAIL_LINES) {
    return null
  }
  const lines: string[] = []
  let characters = 0
  for (const line of value) {
    if (typeof line !== 'string') {
      return null
    }
    characters += line.length
    if (characters > maximumChars) {
      return null
    }
    lines.push(line)
  }
  return lines
}
