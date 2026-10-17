// Picker and transcript rendering use the same OmniRogue mention grammar as the send parser.
import {
  MAX_MENTION_LABEL,
  NO_MENTIONS,
  mentionKey,
  mentionRoster,
  mentionToken,
  resolvable,
  shapes,
  wordChar,
  type ContentSegment,
  type Mention,
  type MentionQuery,
  type MentionRange,
  type MentionRegistry,
  type MentionRoster,
  type RenderedMention
} from './room-mention-parser'
export {
  MAX_AGENT_MENTIONS,
  MAX_MENTION_LABEL,
  MAX_MESSAGE_CONTENT,
  NO_MENTIONS,
  mentionKey,
  mentionLabel,
  mentionRoster,
  mentionToken,
  mentionSendPayload,
  parseMentions,
  type ContentSegment,
  type Mention,
  type MentionKind,
  type MentionQuery,
  type MentionRange,
  type MentionRegistry,
  type MentionRoster,
  type MentionSendPayload,
  type MentionSpan,
  type ParsedMentions,
  type RenderedMention
} from './room-mention-parser'

/** The `@query` being typed at the caret, or null when the picker should close. */
export function mentionQuery(text: string, caretPos: number): MentionQuery | null {
  const caret = Math.max(0, Math.min(Math.trunc(caretPos) || 0, text.length))
  const chips = shapes(text)
  const inChip = (index: number) => chips.some((chip) => index >= chip.start && index < chip.end)
  if (chips.some((chip) => caret > chip.start && caret < chip.end)) {
    return null
  }
  let start = -1
  // A query is bounded: it never spans a chip, a newline, or more characters
  // than a label may hold.
  for (let index = caret - 1; index >= 0 && caret - index <= MAX_MENTION_LABEL + 1; index--) {
    if (inChip(index)) {
      return null
    }
    const character = text[index]!
    if (character === '\n') {
      return null
    }
    if (character === '@') {
      start = index
      break
    }
  }
  if (start < 0) {
    return null
  }
  const before = start > 0 ? text[start - 1]! : ''
  // `sal@example.com` is an address, not a mention.
  if (before && (wordChar.test(before) || before === '@')) {
    return null
  }
  return { query: text.slice(start + 1, caret), start, end: caret }
}

/** What a keystroke should do to an open picker. */
export type MentionKeyAction =
  | { type: 'move'; index: number }
  | { type: 'choose'; index: number }
  | { type: 'dismiss' }
/** Decide the picker's response to a keystroke, or null to leave the keystroke
 * to the textarea — ordinary typing, Enter for a newline, and every key while an
 * IME composition is open, because an IME uses Enter and the arrows to accept
 * its own candidate and must never have them taken by the picker. */
export function mentionKeydown(
  event: { key: string; isComposing?: boolean; keyCode?: number },
  state: { options: number; index: number; composing?: boolean }
): MentionKeyAction | null {
  // keyCode 229 is the IME's "this keystroke is mine" marker. It matters on its
  // own because browsers fire compositionend BEFORE the keydown that confirmed
  // the candidate (MDN, "Handling IME"), so by the time that Enter arrives both
  // `composing` and `isComposing` are already false and only 229 is left.
  if (state.options <= 0 || state.composing || event.isComposing || event.keyCode === 229) {
    return null
  }
  const index = Math.max(0, Math.min(state.index, state.options - 1))
  if (event.key === 'ArrowDown') {
    return { type: 'move', index: (index + 1) % state.options }
  }
  if (event.key === 'ArrowUp') {
    return { type: 'move', index: (index + state.options - 1) % state.options }
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    return { type: 'choose', index }
  }
  if (event.key === 'Escape') {
    return { type: 'dismiss' }
  }
  return null
}

/** Drop registry keys whose chip is no longer in the text, so trust cannot
 * outlive the draft that earned it: an emptied draft prunes to nothing, and a
 * chip the member deleted stops vouching for a token they may retype by hand.
 * Cheap enough to run on every keystroke that changes the draft. */
export function pruneMentions(text: string, registry: MentionRegistry): MentionRegistry {
  if (!registry.size) {
    return registry
  }
  const present = new Set(
    shapes(text).map((token) => mentionKey({ kind: token.kind, id: token.id, label: token.label }))
  )
  const kept = [...registry].filter((key) => present.has(key))
  return kept.length === registry.size ? registry : new Set(kept)
}

/** Mentionable entries matching a picker query, prefix matches first. */
export function mentionCandidates(roster: MentionRoster, query: string, limit = 8): Mention[] {
  const needle = query.trim().toLowerCase()
  const ranked: { entry: Mention; rank: number }[] = []
  for (const entry of mentionRoster(roster)) {
    const label = entry.label.toLowerCase()
    if (!needle) {
      ranked.push({ entry, rank: 1 })
    } else if (label.startsWith(needle)) {
      ranked.push({ entry, rank: 0 })
    } else if (label.includes(needle)) {
      ranked.push({ entry, rank: 1 })
    }
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .slice(0, Math.max(0, limit))
    .map((item) => item.entry)
}

/** Replace the picker's query range with a chip token, and record the choice so
 * `parseMentions` will trust it. The returned registry replaces the old one. */
export function insertMention(
  text: string,
  range: MentionRange,
  mention: Mention,
  registry: MentionRegistry = NO_MENTIONS
): { text: string; caret: number; registry: Set<string> } {
  const start = Math.max(0, Math.min(range.start, text.length)),
    end = Math.max(start, Math.min(range.end, text.length))
  const token = `${mentionToken(mention)} `
  return {
    text: text.slice(0, start) + token + text.slice(end),
    caret: start + token.length,
    registry: new Set([...registry, mentionKey(mention)])
  }
}

/** Split message content into text and mention segments for the transcript. */
export function renderContent(content: string, roster: MentionRoster): ContentSegment[] {
  const entries = mentionRoster(roster)
  const byId = new Map(entries.map((entry) => [`${entry.kind}:${entry.id}`, entry]))
  const byName = new Map<string, Mention | null>()
  for (const entry of entries) {
    const key = entry.label.toLowerCase()
    // Two people called "Sal" make a bare `@Sal` ambiguous; leave it as text.
    byName.set(key, byName.has(key) ? null : entry)
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  const chips = new Map(shapes(content).map((chip) => [chip.start, chip]))
  const segments: ContentSegment[] = []
  let text = ''
  const flush = () => {
    if (text) {
      segments.push({ text })
      text = ''
    }
  }
  const push = (mention: RenderedMention) => {
    flush()
    segments.push({ mention })
  }
  for (let index = 0; index < content.length;) {
    if (content[index] !== '@') {
      text += content[index]
      index++
      continue
    }
    const chip = chips.get(index)
    if (chip) {
      const entry = resolvable(chip) ? byId.get(`${chip.kind}:${chip.id}`) : undefined
      // The label drawn is the roster's, never the token's, so a crafted token
      // cannot put words in a member's mouth. An id nobody in the room owns any
      // more reads as the plain text it wrote.
      if (entry) {
        push({ ...entry, source: 'token' })
      } else {
        text += `@${chip.label}`
      }
      index = chip.end
      continue
    }
    const before = index > 0 ? content[index - 1]! : ''
    const rest = content.slice(index + 1).toLowerCase()
    const name =
      before && (wordChar.test(before) || before === '@')
        ? undefined
        : names.find(
            (candidate) =>
              rest.startsWith(candidate) && !wordChar.test(rest.charAt(candidate.length))
          )
    const entry = name ? byName.get(name) : null
    if (entry) {
      push({ ...entry, source: 'name' })
      index += 1 + name!.length
      continue
    }
    text += '@'
    index++
  }
  flush()
  return segments
}
