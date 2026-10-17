import { z } from 'zod'
import { ARTIFACT_SLUG_PATTERN, type ArtifactReviewDecision } from './artifact-review'

/**
 * A handoff that carries an omnios page for review ("＋ Add next → Person", page attached).
 *
 * The hub has no field for it: like the disposition, it rides as a pointer on the opening entry's
 * references (`{kind:'artifact-review', ref:<slug>, label:<title>}`), which the console relay
 * already validates and the hub already stores. Readers that predate it ignore an unknown kind, and
 * the request itself says it in words — its title reads "Review: <title>" and its note carries the
 * page link — so an older IDE or the web console still shows a usable review request.
 *
 * The decision is never made here or by an agent: the person decides on the signed-in omnios page.
 * The sender's desktop reads the decision back and posts it into the thread.
 */

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/** The longest prefix of `text` within `max` UTF-8 bytes, never splitting a character. */
function clipBytes(text: string, max: number): string {
  let used = 0
  let end = 0
  for (const char of text) {
    const size = bytes(char)
    if (used + size > max) {
      break
    }
    used += size
    end += char.length
  }
  return text.slice(0, end)
}

export const ARTIFACT_REVIEW_REFERENCE_KIND = 'artifact-review'
/** The thread title the recipient sees in Needs you; the hub caps titles at 160 characters. */
const THREAD_TITLE_MAX = 160
/** A reference string is at most 512 bytes; the label is kept well inside the 4 KB budget. */
const LABEL_MAX = 200

export type HandoffArtifactReview = {
  slug: string
  /** What the page is called, as the recipient reads it: "Review: <title>". */
  title: string
  /** The page's own link (`…/a/<slug>`), written into the request so any reader can open it. */
  url?: string
}

/** A page link that names exactly `slug`; anything else is not this page's link. */
function pageUrlFor(slug: string, url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length > 512 || !/^https?:\/\//i.test(url)) {
    return undefined
  }
  return parseArtifactReviewLink(url) === slug ? url : undefined
}

export const handoffArtifactReview = z
  .object({
    slug: z.string().regex(ARTIFACT_SLUG_PATTERN),
    title: z.string().trim().min(1).max(LABEL_MAX),
    url: z.string().max(512).optional()
  })
  .strict()
  .refine((value) => value.url === undefined || pageUrlFor(value.slug, value.url) !== undefined, {
    message: 'The page link does not name this page.'
  })

/** A stored or received value, or null; tolerant of anything an older or newer build wrote. */
export function normalizeHandoffArtifactReview(value: unknown): HandoffArtifactReview | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as { slug?: unknown; title?: unknown }
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : ''
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, LABEL_MAX) : ''
  if (!ARTIFACT_SLUG_PATTERN.test(slug)) {
    return null
  }
  const url = pageUrlFor(slug, (value as { url?: unknown }).url)
  return { slug, title: title || slug, ...(url ? { url } : {}) }
}

export function artifactReviewReference(review: HandoffArtifactReview): {
  kind: string
  ref: string
  label: string
} {
  return {
    kind: ARTIFACT_REVIEW_REFERENCE_KIND,
    ref: review.slug,
    label: review.title.slice(0, LABEL_MAX)
  }
}

const pointer = z.object({
  kind: z.literal(ARTIFACT_REVIEW_REFERENCE_KIND),
  ref: z.string().regex(ARTIFACT_SLUG_PATTERN),
  label: z.string().optional()
})

/** The page a thread was opened to review, read back from the references the hub stored. */
export function handoffArtifactReviewOf(
  entries: readonly { references?: readonly unknown[] | null }[]
): HandoffArtifactReview | null {
  for (const entry of entries) {
    for (const reference of entry.references ?? []) {
      const parsed = pointer.safeParse(reference)
      if (parsed.success) {
        return { slug: parsed.data.ref, title: parsed.data.label?.trim() || parsed.data.ref }
      }
    }
  }
  return null
}

/** "Review: <title>", within the hub's title limit. */
export function artifactReviewThreadTitle(review: HandoffArtifactReview): string {
  const title = `Review: ${review.title}`
  return title.length > THREAD_TITLE_MAX ? `${title.slice(0, THREAD_TITLE_MAX - 1)}…` : title
}

/** The page's own address on the artifact origin. */
export function artifactReviewPageUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}/a/${encodeURIComponent(slug)}`
}

/**
 * The request's note with the page link underneath, so every reader — whatever its version —
 * can open the page. The hub caps an entry body at 8192 bytes; the link is always kept.
 */
export function artifactReviewNote(note: string, pageUrl: string): string {
  const line = `Review the page and decide there: ${pageUrl}`
  const body = note.trim()
  if (!body) {
    return line
  }
  if (body.includes(pageUrl)) {
    return body
  }
  const budget = 8000 - bytes(line)
  return `${bytes(body) > budget ? `${clipBytes(body, budget)}…` : body}\n\n${line}`
}

/**
 * The slug a person pasted: an omnios page link (`…/a/<slug>`, with or without `/content`) or the
 * bare slug. Null for anything else.
 */
export function parseArtifactReviewLink(input: string): string | null {
  const text = input.trim()
  if (ARTIFACT_SLUG_PATTERN.test(text)) {
    return text
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  const match = /^\/a\/([^/]+)(?:\/content)?\/?$/.exec(url.pathname)
  const slug = match?.[1] ? decodeURIComponent(match[1]) : null
  return slug && ARTIFACT_SLUG_PATTERN.test(slug) ? slug : null
}

/** The decisions a page reports, in the words the thread and the review gate use. */
export type ArtifactReviewOutcome = 'approve' | 'request_changes'

export function artifactReviewOutcome(
  decision: ArtifactReviewDecision['decision']
): ArtifactReviewOutcome {
  // Why: a rejection releases nothing held behind the review; it goes back like a change request.
  return decision === 'approved' ? 'approve' : 'request_changes'
}

const DECISION_WORDS: Record<ArtifactReviewDecision['decision'], string> = {
  approved: 'approved',
  changes_requested: 'requested changes',
  rejected: 'rejected'
}

/**
 * What the sender's desktop posts into the thread when the page's decision lands.
 *
 * An approval is `done`: the hub resolves the thread, which clears the sender's Waiting for and
 * the recipient's Needs you. A change request or a rejection is a `reply`: the thread stays open
 * (not resolved) and comes back to the sender as a reply, the same state a hub "needs changes"
 * leaves it in, so the existing re-ask loop asks again on the fixed version.
 */
export function artifactReviewDecisionEntry(
  decision: Pick<ArtifactReviewDecision, 'decision' | 'comment' | 'by'>,
  fallbackName: string
): { kind: 'done' | 'reply'; body: string } {
  const who = decision.by.name.trim() || decision.by.email.trim() || fallbackName.trim()
  const words = DECISION_WORDS[decision.decision] ?? decision.decision
  const comment = decision.comment.trim()
  const body = comment ? `${who} ${words}: ${comment}` : `${who} ${words}.`
  return {
    kind: decision.decision === 'approved' ? 'done' : 'reply',
    // The hub caps an entry body at 8192 bytes; a page comment is shorter, but never trust it.
    body: bytes(body) > 8000 ? `${clipBytes(body, 7990)}…` : body
  }
}

/**
 * One hub idempotency key per (thread, decision): a restart or a second pass replays the same
 * entry instead of posting it twice. Matches the hub's `[A-Za-z0-9_-]{8,160}`.
 */
export function artifactReviewDecisionOperationId(threadId: string, decisionId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_')
  return `artrev_${safe(threadId).slice(0, 130)}_${safe(decisionId).slice(0, 20)}`
}

/**
 * The review id a gate receipt carries for a page decision
 * (`handoff-review:<thread>:<id>:<decision>`): it names the page and the decision, and holds no
 * colon, so the receipt stays one the review gate parses.
 */
const RECEIPT_REVIEW_ID = /^artifact~([A-Za-z0-9_-]{1,128})~([A-Za-z0-9_-]{1,40})$/

export function artifactReviewReceiptId(slug: string, decisionId: string): string {
  return `artifact~${slug}~${decisionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}`
}

export function parseArtifactReviewReceiptId(
  reviewId: string
): { slug: string; decisionId: string } | null {
  const match = RECEIPT_REVIEW_ID.exec(reviewId)
  return match ? { slug: match[1]!, decisionId: match[2]! } : null
}

/**
 * The page decision that answers THIS request: the one on the page's current revision, made after
 * the request was opened. A decision from before the ask, or on a revision the page no longer is,
 * answers nothing now.
 */
export function artifactReviewAnswer(
  status: { latest: ArtifactReviewDecision | null },
  openedAt: number
): ArtifactReviewDecision | null {
  const latest = status.latest
  if (!latest) {
    return null
  }
  const at = Date.parse(latest.at)
  return Number.isFinite(at) && Number.isFinite(openedAt) && at >= openedAt ? latest : null
}

/** When the thread's opening request was created, from the hub's own clock; NaN when unknown. */
export function handoffOpenedAt(entries: readonly { kind: string; created: string }[]): number {
  const opening = entries.find((entry) => entry.kind === 'handoff') ?? entries[0]
  return opening ? Date.parse(opening.created) : Number.NaN
}
