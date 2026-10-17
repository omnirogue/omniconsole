// Adapted with local formatting from OmniRogue's packages/shared/src/rooms/mentions.ts at commit a11b2415c (branch feat/rooms-mentions-ui-0913, repo omnirogue/omnirogue).
/** @mentions for customer Online Rooms. Pure — no DOM, no dependencies — so the
 * OmniConsole desktop can vendor this file beside its copy of onlineRooms.ts.
 *
 * Draft representation. A mention chosen from the picker is written into the
 * draft as a markdown-style token bound to the id it was chosen for:
 *
 *     @[Ada Lovelace](user:0f1e…)      a person in the room
 *     @[Research bot](agent:8c22…)     an agent attached to the room
 *
 * The token carries the id, so a mention never has to be re-resolved from the
 * display name — two members called "Sal" stay distinguishable, and renaming or
 * impersonating a member cannot steal someone else's mention. `]` and `\` inside
 * a label are backslash-escaped; everything else is literal.
 *
 * Provenance. Carrying the id is not by itself permission to route: a member can
 * type the token grammar by hand, and `@[Research bot](agent:<Planner's id>)`
 * would otherwise send the words "Research bot" while addressing Planner. So a
 * chip only counts when the picker inserted it: `insertMention` records
 * `kind:id:label` in a per-draft `MentionRegistry`, and `parseMentions` resolves
 * a token only when its key is in that registry. Everything else is text.
 * (The registry is per draft, so retyping a chip that is still registered — same
 * kind, id and label — is indistinguishable from the picker's own and stays
 * trusted. Deleting the chip and sending clears the registry.)
 *
 * Wire representation. `POST /:roomId/messages` takes a `.strict()` body with no
 * mention field, so tokens never leave the client: `parseMentions(draft).text` is
 * the readable `@Label` form that goes out as `content`, and the agent ids go out
 * as `targetAgentIds` (the field the server already validates). The composer sends the resolved people spans in the server’s mentions field.
 *
 * No token shape ever leaves the client. Anything token-*shaped* is stripped to
 * its readable form whether or not it resolves — an over-long label, a stale id,
 * a hand-typed token — and `readable()` then neutralises any shape the stripping
 * itself spliced together out of a label and the text after it. Otherwise a
 * crafted message could arrive in someone else's transcript as a chip.
 *
 * `renderContent` reads both forms: the token form (local echo of a draft, and
 * whatever a future server stores) and — cosmetically only — a plain `@Label`
 * that exactly and unambiguously matches one roster name. It takes no registry
 * because it decides nothing: it draws a chip, and the label it draws always
 * comes from the roster entry, never from the token. Only `parseMentions` and
 * `mentionSendPayload` may decide who a message is addressed to.
 */

/** The server caps `targetAgentIds` at 5 (`z.array(uuid).max(5)`). */
export const MAX_AGENT_MENTIONS = 5
/** Room display names are `min(1).max(60)` server-side; labels follow them. */
export const MAX_MENTION_LABEL = 60
/** The server takes `content` as `z.string().trim().min(1).max(3000)`. Its other
 * limit — 12 000 UTF-8 bytes — cannot bind first: 3 000 UTF-16 code units are at
 * most 9 000 bytes, so the character cap is the only one a client must enforce. */
export const MAX_MESSAGE_CONTENT = 3000

export type MentionKind = 'agent' | 'user'
export type Mention = {
  kind: MentionKind
  id: string
  label: string
}
/** A resolved mention plus its offsets in the readable text it was parsed into. */
export type MentionSpan = {
  start: number
  end: number
} & Mention
/** The room roster, shaped as the room detail already delivers it. */
export type MentionRoster = {
  agents?: { id: string; name: string }[]
  members?: { userId: string; name: string }[]
}
/** The chips the picker put in one draft, as `mentionKey` values. */
export type MentionRegistry = ReadonlySet<string>
/** An empty registry: no token in the text was chosen from a picker. */
export const NO_MENTIONS: MentionRegistry = new Set<string>()
export type ParsedMentions = {
  /** Attached agents to address, deduplicated, at most MAX_AGENT_MENTIONS. */
  agentIds: string[]
  /** Mentioned people, deduplicated. */
  userIds: string[]
  /** Resolved mentions in document order, offset into `text`. */
  spans: MentionSpan[]
  /** The readable text to send: every token shape replaced by `@Label`. */
  text: string
  /** True when the draft mentioned more than MAX_AGENT_MENTIONS agents. */
  agentsTruncated: boolean
}
export type MentionRange = {
  start: number
  end: number
}
export type MentionQuery = {
  query: string
} & MentionRange
export type RenderedMention = Mention & { source: 'token' | 'name' }
/** A transcript segment: literal text, or a mention to draw as a chip. */
export type ContentSegment = { text: string } | { mention: RenderedMention }

// Deliberately permissive: this matches anything token-SHAPED, whatever its
// label length. Every match is stripped from outgoing content; only the subset
// that also passes `resolvable` and the registry becomes a mention. The id is
// loose for the same reason — roster membership, not the shape of the string,
// is what makes a mention real.
const TOKEN_SHAPE = /@\[((?:[^\\\]\n]|\\[\\\]])*)\]\((agent|user):([A-Za-z0-9_-]{1,64})\)/g
// The two sequences a token needs. A string with neither cannot become one.
const GRAMMAR = /@\[|\]\(/
const escapeLabel = (label: string) => label.replace(/[\\\]]/g, (match) => `\\${match}`)
const unescapeLabel = (raw: string) => raw.replace(/\\([\\\]])/g, '$1')
export const wordChar = /[A-Za-z0-9_]/

/** Collapse a display name into a label safe to put inside a token. */
export function mentionLabel(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_MENTION_LABEL)
}
/** The registry key for a chip: the picker's exact choice, label included, so a
 * hand-typed token that borrows the id but changes the words does not match. */
export function mentionKey(mention: Mention): string {
  return `${mention.kind}:${mention.id}:${mentionLabel(mention.label)}`
}
/** The draft token for a mention. `label` is normalised and escaped. */
export function mentionToken(mention: Mention): string {
  return `@[${escapeLabel(mentionLabel(mention.label))}](${mention.kind}:${mention.id})`
}
/** Everyone who can be mentioned, agents first, in roster order. A display name
 * that contains the token grammar is not offered: the picker must never build a
 * chip whose own label could be read back as a second token. */
export function mentionRoster(roster: MentionRoster): Mention[] {
  return [
    ...(roster.agents ?? []).map((agent) => ({
      kind: 'agent' as const,
      id: agent.id,
      label: mentionLabel(agent.name)
    })),
    ...(roster.members ?? []).map((member) => ({
      kind: 'user' as const,
      id: member.userId,
      label: mentionLabel(member.name)
    }))
  ].filter((entry) => entry.id && entry.label && !GRAMMAR.test(entry.label))
}
type RawToken = {
  kind: MentionKind
  id: string
  label: string
} & MentionRange
/** Every token-shaped substring, resolvable or not. */
export function shapes(text: string): RawToken[] {
  const found: RawToken[] = []
  TOKEN_SHAPE.lastIndex = 0
  for (let match = TOKEN_SHAPE.exec(text); match; match = TOKEN_SHAPE.exec(text)) {
    found.push({
      start: match.index,
      end: match.index + match[0]!.length,
      kind: match[2] as MentionKind,
      id: match[3]!,
      label: unescapeLabel(match[1]!)
    })
  }
  return found
}
/** A shape whose label could have come from a roster display name. */
export const resolvable = (token: RawToken) =>
  token.label.length > 0 && token.label.length <= MAX_MENTION_LABEL
/** Break any token shape left in readable text by spacing its `@[` apart, and
 * report where a space went in so callers can move their offsets. Stripping a
 * chip can splice a new shape out of a label ending in `@` and the text that
 * followed it, so this runs until nothing token-shaped is left. */
function readable(text: string): { text: string; cuts: number[] } {
  const cuts: number[] = []
  let out = text
  for (let guard = 0; guard <= text.length; guard++) {
    TOKEN_SHAPE.lastIndex = 0
    const match = TOKEN_SHAPE.exec(out)
    if (!match) {
      break
    }
    const at = match.index + 1
    cuts.push(at - cuts.length)
    out = `${out.slice(0, at)} ${out.slice(at)}`
  }
  return { text: out, cuts }
}

/** Read a draft: the ids it addresses and the readable text to send. Only chips
 * the picker inserted — the keys in `registry` — can address anyone. */
export function parseMentions(
  text: string,
  roster: MentionRoster,
  registry: MentionRegistry = NO_MENTIONS
): ParsedMentions {
  const known = new Map(mentionRoster(roster).map((entry) => [`${entry.kind}:${entry.id}`, entry]))
  const agentIds: string[] = [],
    userIds: string[] = [],
    spans: MentionSpan[] = []
  const agentsSeen = new Set<string>()
  let out = '',
    cursor = 0
  for (const token of shapes(text)) {
    out += text.slice(cursor, token.start)
    const start = out.length
    // Every shape strips to `@Label`, resolved or not, so no raw token — a stale
    // id, an over-long label, one typed by hand — can leak into `content`.
    out += `@${token.label}`
    cursor = token.end
    const entry = resolvable(token) ? known.get(`${token.kind}:${token.id}`) : undefined
    // The id must be on the roster AND this token's own words must be a choice
    // the picker made. Keying on the token's label — not the roster's — is what
    // catches `@[Research bot](agent:<Planner's id>)`: the words and the id come
    // from different entries, so the key is one the picker never wrote.
    if (
      !entry ||
      !registry.has(mentionKey({ kind: token.kind, id: token.id, label: token.label }))
    ) {
      continue
    }
    spans.push({ start, end: out.length, kind: token.kind, id: token.id, label: entry.label })
    if (token.kind === 'agent') {
      if (agentsSeen.has(token.id)) {
        continue
      }
      agentsSeen.add(token.id)
      if (agentIds.length < MAX_AGENT_MENTIONS) {
        agentIds.push(token.id)
      }
    } else if (!userIds.includes(token.id)) {
      userIds.push(token.id)
    }
  }
  out += text.slice(cursor)
  const safe = readable(out)
  // A space inserted at or before a span's start moves the whole span; one
  // inserted strictly inside it only moves its end.
  const shiftStart = (offset: number) => offset + safe.cuts.filter((cut) => cut <= offset).length
  const shiftEnd = (offset: number) => offset + safe.cuts.filter((cut) => cut < offset).length
  return {
    agentIds,
    userIds,
    text: safe.text,
    agentsTruncated: agentsSeen.size > MAX_AGENT_MENTIONS,
    spans: safe.cuts.length
      ? spans.map((span) => ({ ...span, start: shiftStart(span.start), end: shiftEnd(span.end) }))
      : spans
  }
}

export type MentionSendPayload = {
  /** `content` for the strict message body: readable, no token shapes. */
  content: string
  /** `targetAgentIds` for the strict message body. */
  targetAgentIds: string[]
  /** Mentioned people. No wire field carries these yet — client-side only. */
  userIds: string[]
  /** The draft addresses more agents than one message may carry. */
  overLimit: boolean
  /** `content` is longer than the server will accept. */
  tooLong: boolean
}
/** Turn a draft into the wire body. `fallbackAgentId` is the compose select's
 * choice, kept as a fallback for members who never type `@`; an id that is not
 * on the roster is dropped rather than sent for the server to reject. A caller
 * must refuse to send while `overLimit` or `tooLong` is set — both are rejections
 * the server would make deterministically, and a retry cannot change them. */
export function mentionSendPayload(
  draft: string,
  roster: MentionRoster,
  registry: MentionRegistry,
  fallbackAgentId = ''
): MentionSendPayload {
  const parsed = parseMentions(draft.trim(), roster, registry)
  const attached = new Set((roster.agents ?? []).map((agent) => agent.id))
  const fallback = fallbackAgentId && attached.has(fallbackAgentId) ? [fallbackAgentId] : []
  const targetAgentIds = [...new Set([...parsed.agentIds, ...fallback])]
  const content = parsed.text.trim()
  return {
    content,
    targetAgentIds,
    userIds: parsed.userIds,
    overLimit: parsed.agentsTruncated || targetAgentIds.length > MAX_AGENT_MENTIONS,
    tooLong: content.length > MAX_MESSAGE_CONTENT
  }
}
