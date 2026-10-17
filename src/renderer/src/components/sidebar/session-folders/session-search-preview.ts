import {
  mapNormalizedRange,
  normalizePaletteText,
  type MatchRange
} from '@/lib/palette-match/normalized-text'
import {
  SESSION_SEARCH_MARK_CLOSE as CLOSE,
  SESSION_SEARCH_MARK_OPEN as OPEN,
  type SessionSearchHit
} from '../../../../../shared/session-search-types'

export const SESSION_SEARCH_PREVIEW_MAX_CHARS = 320

function markedText(source: string): { text: string; ranges: MatchRange[] } {
  let text = ''
  let start: number | null = null
  const ranges: MatchRange[] = []
  for (const part of source
    .replace(/\s+/g, ' ')
    .trim()
    .split(new RegExp(`(${OPEN}|${CLOSE})`))) {
    if (part === OPEN) {
      start = text.length
    } else if (part === CLOSE) {
      if (start !== null && start < text.length) {
        ranges.push({ start, end: text.length })
      }
      start = null
    } else {
      text += part
    }
  }
  return { text, ranges }
}

function queryRange(text: string, query: string): MatchRange | null {
  const folded = normalizePaletteText(text)
  const normalized = normalizePaletteText(query).normalized.replace(/\s+/g, ' ').trim()
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  const candidates = [normalized, ...words.sort((a, b) => b.length - a.length)]
  for (const candidate of candidates) {
    const start = candidate ? folded.normalized.indexOf(candidate) : -1
    if (start >= 0) {
      return mapNormalizedRange(folded, start, start + candidate.length)
    }
  }
  return null
}

/** Bound remote and local previews alike, keeping the matching passage near the front. */
export function sessionSearchPreview(
  hit: Pick<SessionSearchHit, 'snippets' | 'summary'>,
  query: string
): string {
  const snippets = hit.snippets.map((snippet) => snippet.text).filter((text) => text.trim())
  const source = snippets.find((text) => text.includes(OPEN)) ?? snippets[0] ?? hit.summary ?? ''
  const { text, ranges } = markedText(source)
  if (ranges.length === 0) {
    const match = queryRange(text, query)
    if (match) {
      ranges.push(match)
    }
  }
  const budget = SESSION_SEARCH_PREVIEW_MAX_CHARS - 2
  let start =
    text.length > SESSION_SEARCH_PREVIEW_MAX_CHARS ? Math.max(0, (ranges[0]?.start ?? 0) - 40) : 0
  let end =
    text.length > SESSION_SEARCH_PREVIEW_MAX_CHARS
      ? Math.min(text.length, start + budget)
      : text.length
  // Keep UTF-16 surrogate pairs intact without exceeding the character budget.
  if (start > 0 && (text.charCodeAt(start) & 0xfc00) === 0xdc00) {
    start += 1
  }
  if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800) {
    end -= 1
  }
  let preview = text.slice(start, end)
  for (const range of ranges.toReversed()) {
    const left = Math.max(start, range.start) - start
    const right = Math.min(end, range.end) - start
    if (right > left) {
      preview = `${preview.slice(0, left)}${OPEN}${preview.slice(left, right)}${CLOSE}${preview.slice(right)}`
    }
  }
  return `${start > 0 ? '…' : ''}${preview}${end < text.length ? '…' : ''}`
}
