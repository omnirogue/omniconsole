// ─── The transcript a person handoff delivers ───────────────────────────────
// Turns a captured conversation into the exact file bytes a handoff attaches.
//
// The redactor is a gate here, not a scrubber. `serializeConsoleWorkflowRequest`
// set the precedent for reviewed data leaving this machine: if redaction would
// change the payload, the request is refused rather than quietly rewritten. A
// transcript is the same kind of payload — the owner consented to send *this*
// session, not to have a secret silently swapped out of it and the rest sent —
// so a match refuses with `transcript_contains_protected_data` and names how
// many sites matched, never the values.

import { createHash } from 'node:crypto'
import { redactString } from '../observability/redactor'
import {
  renderTranscriptMarkdown,
  transcriptCompletePayloads,
  TranscriptTooLargeError,
  type TranscriptRenderOptions,
  type TranscriptRenderResult
} from '../../shared/transcript-render'
import type { NativeChatMessage } from '../../shared/native-chat-types'

export { TranscriptTooLargeError }

export const TRANSCRIPT_PROTECTED_DATA_CODE = 'transcript_contains_protected_data'

/** Fixed location inside the recipient's handoff payload. */
export const TRANSCRIPT_TARGET_PATH = 'handoff/transcript.md'

export class TranscriptDeliverableError extends Error {
  readonly code = TRANSCRIPT_PROTECTED_DATA_CODE
  readonly redactions: number
  constructor(message: string, redactions: number) {
    super(message)
    this.name = 'TranscriptDeliverableError'
    this.redactions = redactions
  }
}

export type TranscriptCapture = {
  messages: readonly NativeChatMessage[]
  agent: string
  model?: string | null
  sessionId: string
  /** ISO 8601 capture time; also dates the file name. */
  capturedAt: string
  /** Digest of the source capture, recorded in the document header. */
  sourceDigest: string
  /** The reader returned only the session's tail. */
  earlierMessagesOmitted?: boolean
  /** Records the reader skipped; disclosed in the document. */
  omittedRecords?: number
  /** False for the employee upload: whole tool payloads, bounded by the document cap. */
  clipToolPayloads?: boolean
}

export type TranscriptDeliverable = {
  name: string
  bytes: Buffer
  sha256: string
  size: number
  /** Sites the redactor matched. Always 0 on a returned deliverable — a
   *  non-zero count refuses — and reported on the refusal so the owner can
   *  see how much matched without the transcript echoing any value. */
  redactions: number
  messageCount: number
  truncatedBlocks: number
}

const REDACTION_MARKER = /\[redacted(?::[a-z0-9-]+)?\]/g

function countRedactionMarkers(value: string): number {
  return (value.match(REDACTION_MARKER) ?? []).length
}

/** Keep the session's identity in the name while staying a legal file name. */
function fileNameSlug(sessionId: string): string {
  // No dots: a name is never allowed to read as a path segment like `..`.
  const slug = sessionId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return (slug || 'session').slice(0, 80)
}

function fileNameDate(capturedAt: string): string {
  const parsed = new Date(capturedAt)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('The transcript capture has no valid captured-at time.')
  }
  return parsed.toISOString().slice(0, 10).replaceAll('-', '')
}

export function transcriptFileName(sessionId: string, capturedAt: string): string {
  return `transcript-${fileNameSlug(sessionId)}-${fileNameDate(capturedAt)}.md`
}

export function renderTranscriptCapture(
  capture: TranscriptCapture,
  maxBytes?: number
): TranscriptRenderResult {
  const options: TranscriptRenderOptions = {
    agent: capture.agent,
    sessionId: capture.sessionId,
    capturedAt: capture.capturedAt,
    sourceDigest: capture.sourceDigest,
    sha256: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
    ...(capture.model === undefined ? {} : { model: capture.model }),
    ...(capture.earlierMessagesOmitted ? { earlierMessagesOmitted: true } : {}),
    ...(capture.omittedRecords ? { omittedRecords: capture.omittedRecords } : {}),
    ...(capture.clipToolPayloads === undefined
      ? {}
      : { clipToolPayloads: capture.clipToolPayloads }),
    ...(maxBytes === undefined ? {} : { maxBytes })
  }
  return renderTranscriptMarkdown(capture.messages, options)
}

/**
 * Build the transcript file for a person handoff, or refuse. Never returns a
 * scrubbed document: the owner reviews and re-runs after removing the secret,
 * or sends the work files instead.
 */
export function buildTranscriptDeliverable(
  capture: TranscriptCapture,
  maxBytes?: number
): TranscriptDeliverable {
  const payloads = transcriptCompletePayloads(capture.messages)
  // Gate 1 — the opening scan, before any regex touches any of this text.
  // `redactString`'s PEM rule is quadratic on unmatched openings, so running it
  // first on a payload that repeats `-----BEGIN …-----` is itself the denial of
  // service: 1.4 MB of repeated openings — inside the reader's record limit —
  // took seconds. The linear walk runs first over every payload and then over
  // the joined text, so no regex ever sees an opening at all.
  let openings = 0
  for (const payload of payloads) {
    openings += countPemOpenings(payload)
  }
  if (openings > 0) {
    throw protectedDataRefusal(openings)
  }
  // Joined with NO separator: a delimiter torn across two outputs as
  // `-----END PRIVATE` + ` KEY-----` is only whole when they are butted
  // together, so any separator here would be a bypass of its own.
  const combined = payloads.join('')
  const straddlingOpenings = countPemOpenings(combined)
  if (straddlingOpenings > 0) {
    throw protectedDataRefusal(straddlingOpenings)
  }
  // Past this line the text provably holds no `-----BEGIN`, so the PEM rule's
  // lazy `[\s\S]+?` has nothing to backtrack on and every pass below is linear.
  //
  // Gate 2 — every complete payload, before any clipping. A 5 KiB PEM body
  // clipped to its 4 KiB head loses `-----END …-----`, and the rule anchored on
  // that delimiter stops matching a key the document still half-contains.
  const preClip = countPayloadRedactions(payloads)
  if (preClip > 0) {
    throw protectedDataRefusal(preClip)
  }
  // Gate 3 — the joined text, catching a single-line family straddling a
  // boundary (a provider key whose halves sit in adjacent payloads).
  const straddling = countPayloadRedactions([combined])
  if (straddling > 0) {
    throw protectedDataRefusal(straddling)
  }
  const rendered = renderTranscriptCapture(capture, maxBytes)
  // Gate 4 — the assembled document, which the header, footer and fences add to.
  const redacted = redactString(rendered.markdown)
  if (redacted !== rendered.markdown) {
    const redactions = Math.max(
      1,
      countRedactionMarkers(redacted) - countRedactionMarkers(rendered.markdown)
    )
    throw protectedDataRefusal(redactions)
  }
  return finishTranscriptDeliverable(capture, rendered, redacted)
}

const PEM_BEGIN = '-----BEGIN'
const PEM_END = '-----END'

/**
 * Count PEM openings in one forward pass.
 *
 * The redactor's PEM rule pairs `-----BEGIN …-----` with `-----END …-----`
 * through a lazy `[\s\S]+?`. On text holding many *unmatched* openings that
 * costs a scan to the end of the input per opening — quadratic, and a
 * transcript is attacker-influenced text, so that is a denial of service, not
 * just a slow path. This walks the text once instead: `indexOf` only ever moves
 * forward, so the whole scan is linear in the input.
 *
 * Every opening counts, matched or not. A matched pair spanning two payloads is
 * a key the per-payload gate could not see. An unmatched opening is the
 * clipping case itself — the body is present and the closing delimiter was cut
 * — which is exactly what this gate exists to catch.
 */
export function countPemOpenings(text: string): number {
  let found = 0
  let position = 0
  while (position < text.length) {
    const begin = text.indexOf(PEM_BEGIN, position)
    if (begin === -1) {
      return found
    }
    found += 1
    const end = text.indexOf(PEM_END, begin + PEM_BEGIN.length)
    // Past this opening's close, or past the input when it has none.
    position = end === -1 ? text.length : end + PEM_END.length
  }
  return found
}

function countPayloadRedactions(payloads: readonly string[]): number {
  let found = 0
  for (const payload of payloads) {
    const redacted = redactString(payload)
    if (redacted !== payload) {
      found += Math.max(1, countRedactionMarkers(redacted) - countRedactionMarkers(payload))
    }
  }
  return found
}

function protectedDataRefusal(redactions: number): TranscriptDeliverableError {
  return new TranscriptDeliverableError(
    `This transcript contains ${redactions} value${redactions === 1 ? '' : 's'} the redactor treats as a secret, so it was not sent (${TRANSCRIPT_PROTECTED_DATA_CODE}). Remove the secret from the session, or send the work files without the transcript.`,
    redactions
  )
}

function finishTranscriptDeliverable(
  capture: TranscriptCapture,
  rendered: TranscriptRenderResult,
  redacted: string
): TranscriptDeliverable {
  const bytes = Buffer.from(redacted, 'utf8')
  return {
    name: transcriptFileName(capture.sessionId, capture.capturedAt),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
    redactions: 0,
    messageCount: rendered.messageCount,
    truncatedBlocks: rendered.truncatedBlocks
  }
}
