/**
 * Bounded, inert "recent output" tail for parked terminal panes.
 * Why: parking disposes the xterm view (and its WebGL context); background
 * previews read this instead. It is never replayed into xterm and never the
 * restore source — the host snapshot stays authoritative on reveal.
 */
import { stripTerminalControl } from '../../../../shared/terminal-control-stripping'
import {
  TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES,
  TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES,
  TERMINAL_PARKED_PREVIEW_TAIL_MAX_LINES
} from './terminal-hidden-view-parking'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
// Why OSC first and `[`/`]` excluded from the 2-byte form: otherwise `ESC]` reads as a
// complete escape and the OSC payload (titles, hyperlink URLs) leaks into the preview.
const OSC_SEQUENCE_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const COMPLETE_ESCAPE_AT_START_RE = new RegExp(
  `^${ESC}(?:\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\^_])`
)
// Why: an unterminated OSC can be arbitrarily long; past this it is dropped, not held or shown.
const MAX_HELD_ESCAPE_CODE_UNITS = 256

export type TerminalPreviewTailLimits = { maxLines: number; maxBytes: number }

export type ParkedTerminalPreviewTailSnapshot = {
  ptyId: string
  /** Label consumers must show: sanitized recent output, not a faithful screen. */
  sourceKind: 'recent-output'
  /** Changes whenever the tail is recreated, so a consumer can detect PTY replacement. */
  epoch: number
  lastPreviewLines: string[]
  bytes: number
  truncated: boolean
  lastUpdatedAt: number
}

export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (isHighSurrogate(code) && index + 1 < text.length) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** Longest suffix of `text` that fits in `maxBytes` without splitting a surrogate pair. */
export function takeUtf8Tail(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) {
    return text
  }
  let bytes = 0
  let start = text.length
  while (start > 0) {
    const low = text.charCodeAt(start - 1)
    const isPair =
      low >= 0xdc00 && low <= 0xdfff && start >= 2 && isHighSurrogate(text.charCodeAt(start - 2))
    const width = isPair ? 2 : 1
    const cost = utf8ByteLength(text.slice(start - width, start))
    if (bytes + cost > maxBytes) {
      break
    }
    bytes += cost
    start -= width
  }
  return text.slice(start)
}

/** Bare CR returns to column 0, so only text after the last one survives (progress bars). */
function resolveCarriageReturns(line: string): string {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  const lastReturn = trimmed.lastIndexOf('\r')
  return lastReturn === -1 ? trimmed : trimmed.slice(lastReturn + 1)
}

function splitHeldEscape(data: string): [text: string, held: string] {
  const lastEscape = data.lastIndexOf(ESC)
  if (lastEscape === -1) {
    return [data, '']
  }
  const suffix = data.slice(lastEscape)
  if (COMPLETE_ESCAPE_AT_START_RE.test(suffix)) {
    return [data, '']
  }
  return [data.slice(0, lastEscape), suffix.length > MAX_HELD_ESCAPE_CODE_UNITS ? '' : suffix]
}

export type TerminalPreviewTailRing = {
  append: (data: string) => void
  getLines: () => string[]
  getBytes: () => number
  isTruncated: () => boolean
}

/**
 * Fixed-capacity ring of committed lines plus one open partial line.
 * Why ring indices: per-chunk array copies would make a chatty parked PTY pay
 * O(lines) on every write; eviction here is O(1) per dropped line.
 */
export function createTerminalPreviewTailRing(
  limits: TerminalPreviewTailLimits
): TerminalPreviewTailRing {
  const maxLines = Math.max(1, Math.floor(limits.maxLines))
  const maxBytes = Math.max(1, Math.floor(limits.maxBytes))
  const slots: string[] = Array.from({ length: maxLines }, () => '')
  const slotBytes: number[] = Array.from({ length: maxLines }, () => 0)
  let head = 0
  let count = 0
  let committedBytes = 0
  let partial = ''
  let partialBytes = 0
  let partialVisible = false
  let heldEscape = ''
  let truncated = false

  const evictOldest = (): void => {
    committedBytes -= slotBytes[head]
    slots[head] = ''
    slotBytes[head] = 0
    head = (head + 1) % maxLines
    count -= 1
    truncated = true
  }

  const enforceBudget = (): void => {
    const partialLines = partialVisible ? 1 : 0
    while (
      count > 0 &&
      (count + partialLines > maxLines || committedBytes + partialBytes > maxBytes)
    ) {
      evictOldest()
    }
  }

  const fitLine = (line: string): string => {
    const fitted = takeUtf8Tail(line, maxBytes)
    if (fitted.length !== line.length) {
      truncated = true
    }
    return fitted
  }

  const commitLine = (rawLine: string): void => {
    const line = fitLine(resolveCarriageReturns(rawLine))
    if (count === maxLines) {
      evictOldest()
    }
    const slot = (head + count) % maxLines
    slots[slot] = line
    slotBytes[slot] = utf8ByteLength(line)
    committedBytes += slotBytes[slot]
    count += 1
  }

  const setPartial = (raw: string): void => {
    // Why keep a trailing CR: a CRLF split across chunks must still end the line, not erase it.
    const pendingReturn = raw.endsWith('\r')
    const resolved = fitLine(resolveCarriageReturns(raw))
    partial = pendingReturn ? `${resolved}\r` : resolved
    partialBytes = utf8ByteLength(resolved)
    partialVisible = resolved.length > 0
  }

  return {
    append: (data) => {
      const [text, held] = splitHeldEscape(heldEscape + data)
      heldEscape = held
      const sanitized = stripTerminalControl(text.replace(OSC_SEQUENCE_RE, ''))
      if (sanitized.length === 0) {
        return
      }
      const segments = (partial + sanitized).split('\n')
      for (let index = 0; index < segments.length - 1; index += 1) {
        commitLine(segments[index])
      }
      setPartial(segments.at(-1) ?? '')
      enforceBudget()
    },
    getLines: () => {
      const lines: string[] = []
      for (let offset = 0; offset < count; offset += 1) {
        lines.push(slots[(head + offset) % maxLines])
      }
      const openLine = resolveCarriageReturns(partial)
      if (openLine.length > 0) {
        lines.push(openLine)
      }
      return lines
    },
    getBytes: () => committedBytes + partialBytes,
    isTruncated: () => truncated
  }
}

type ParkedPreviewTailEntry = {
  ring: TerminalPreviewTailRing
  epoch: number
  bytes: number
  lastUpdatedAt: number
}

// Why Map order: re-inserting on every write keeps it least-recently-updated first for aggregate eviction.
const tailsByPtyId = new Map<string, ParkedPreviewTailEntry>()
let aggregateBytes = 0
let nextEpoch = 1

function deleteTail(ptyId: string): void {
  const entry = tailsByPtyId.get(ptyId)
  if (!entry) {
    return
  }
  aggregateBytes -= entry.bytes
  tailsByPtyId.delete(ptyId)
}

/** Single writer per PTY: the parked side-effect watcher that already owns its bytes. */
export function appendParkedTerminalPreviewOutput(
  ptyId: string,
  data: string,
  now: number = Date.now()
): void {
  let entry = tailsByPtyId.get(ptyId)
  if (entry) {
    tailsByPtyId.delete(ptyId)
  } else {
    entry = {
      ring: createTerminalPreviewTailRing({
        maxLines: TERMINAL_PARKED_PREVIEW_TAIL_MAX_LINES,
        maxBytes: TERMINAL_PARKED_PREVIEW_TAIL_MAX_BYTES
      }),
      epoch: nextEpoch++,
      bytes: 0,
      lastUpdatedAt: now
    }
  }
  tailsByPtyId.set(ptyId, entry)
  entry.ring.append(data)
  const nextBytes = entry.ring.getBytes()
  aggregateBytes += nextBytes - entry.bytes
  entry.bytes = nextBytes
  entry.lastUpdatedAt = now
  for (const staleId of tailsByPtyId.keys()) {
    if (aggregateBytes <= TERMINAL_PARKED_PREVIEW_TAIL_AGGREGATE_MAX_BYTES || staleId === ptyId) {
      break
    }
    deleteTail(staleId)
  }
}

export function getParkedTerminalPreviewTail(
  ptyId: string
): ParkedTerminalPreviewTailSnapshot | null {
  const entry = tailsByPtyId.get(ptyId)
  if (!entry) {
    return null
  }
  return {
    ptyId,
    sourceKind: 'recent-output',
    epoch: entry.epoch,
    lastPreviewLines: entry.ring.getLines(),
    bytes: entry.bytes,
    truncated: entry.ring.isTruncated(),
    lastUpdatedAt: entry.lastUpdatedAt
  }
}

/** Reveal, close, or PTY replacement: the authoritative xterm/snapshot takes over. */
export function clearParkedTerminalPreviewTail(ptyId: string): void {
  deleteTail(ptyId)
}

export function getParkedTerminalPreviewTailCensus(): { tails: number; bytes: number } {
  return { tails: tailsByPtyId.size, bytes: aggregateBytes }
}

export function resetParkedTerminalPreviewTailsForTests(): void {
  tailsByPtyId.clear()
  aggregateBytes = 0
}
