// ─── Session transcript → a readable, bounded Markdown deliverable ──────────
// A person handoff can carry the session's own transcript as a file the
// recipient opens. This module is the renderer: pure, deterministic, and free
// of ambient I/O so both processes and the tests produce byte-identical output
// for the same capture.
//
// Every bound is marked, never silently dropped — the same contract the agent
// session journal keeps for tool payloads (`journal-payload-bounds.ts`), whose
// truncation marker this module reuses verbatim so one wording covers both.

import type { NativeChatBlock, NativeChatMessage, NativeChatRole } from './native-chat-types'

/** Bytes of a tool call's serialized input kept in the document. */
export const TRANSCRIPT_TOOL_INPUT_HEAD_BYTES = 2 * 1024
/** Bytes of a tool result's output kept in the document. */
export const TRANSCRIPT_TOOL_OUTPUT_HEAD_BYTES = 4 * 1024
/** A transcript above this refuses rather than shipping a clipped document. */
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024

/** Word-for-word the agent journal's marker, so a reader meets one wording for
 *  a clipped payload wherever it was clipped. */
export function transcriptTruncationMarker(byteLength: number, digest: string): string {
  return `\n[OmniConsole: output truncated — ${byteLength} bytes total, digest ${digest.slice(0, 12)}]`
}

/** The document exceeded its byte bound. A class, not a message, so a caller
 *  at a trust boundary can answer with a fixed code and never forward prose. */
export class TranscriptTooLargeError extends Error {
  readonly bytes: number
  readonly maxBytes: number
  constructor(bytes: number, maxBytes: number) {
    super(
      `The session transcript is ${bytes} bytes, above the ${maxBytes} byte limit for a handoff transcript. Send the work files instead; the transcript was not truncated.`
    )
    this.name = 'TranscriptTooLargeError'
    this.bytes = bytes
    this.maxBytes = maxBytes
  }
}

export type TranscriptRenderOptions = {
  agent: string
  model?: string | null
  sessionId: string
  /** ISO 8601; the caller's captured-at, never read from the clock here. */
  capturedAt: string
  /** Digest of the source capture this document was rendered from. */
  sourceDigest: string
  /** Injected so this module stays pure: node:crypto in main, WebCrypto-free in tests. */
  sha256: (value: string) => string
  maxBytes?: number
  /** Default true: tool inputs/outputs are clipped to their head for a person
   *  handoff. False renders every payload whole, bounded only by `maxBytes` —
   *  the employee transcript upload, where the record must be complete. */
  clipToolPayloads?: boolean
  /** The reader returned a tail, not the whole session. Said plainly in the
   *  document rather than letting it read as a complete transcript. */
  earlierMessagesOmitted?: boolean
  /** Records the reader could not decode or that exceeded its record limit.
   *  A skipped message leaves a hole in the middle of the conversation, so the
   *  document must never present itself as continuous. */
  omittedRecords?: number
}

export type TranscriptRenderResult = {
  markdown: string
  messageCount: number
  /** Tool payloads clipped to their head; each carries a marker in the body. */
  truncatedBlocks: number
  bytes: number
}

// Reasoning and system messages are the agent's private working state, not the
// conversation the owner agreed to hand over; the footer says they are absent.
const ROLE_LABELS: Partial<Record<NativeChatRole, string>> = {
  user: 'Person',
  assistant: 'Agent',
  tool: 'Tool'
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function transcriptByteLength(value: string): number {
  return encoder.encode(value).length
}

/** Clip at a byte budget without splitting a multi-byte character. */
function clipUtf8(value: string, maxBytes: number): { text: string; clipped: boolean } {
  const bytes = encoder.encode(value)
  if (bytes.length <= maxBytes) {
    return { text: value, clipped: false }
  }
  let end = maxBytes
  // A UTF-8 continuation byte is 0b10xxxxxx; walk back off a split sequence.
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  return { text: decoder.decode(bytes.subarray(0, end)), clipped: true }
}

/** A fenced block whose fence is always longer than any run inside it, so tool
 *  output that itself contains ``` cannot break out of the code span. */
function fence(body: string, language: string): string {
  const longest = [...body.matchAll(/`+/g)].reduce((max, run) => Math.max(max, run[0].length), 0)
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}${language}\n${body}\n${ticks}`
}

function timeLabel(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return 'time unknown'
  }
  return new Date(timestamp).toISOString()
}

function serializeToolInput(input: unknown): { text: string; language: string } {
  if (typeof input === 'string') {
    return { text: input, language: '' }
  }
  const serialized = JSON.stringify(input, null, 2)
  return serialized === undefined
    ? { text: String(input), language: '' }
    : { text: serialized, language: 'json' }
}

/** A transcript source above this is refused before it is serialized, scanned
 *  or rendered. The document itself caps at 8 MiB; this bounds the input that
 *  produces it, so an oversized session costs one walk rather than a serialized
 *  copy and a full redaction pass. */
export const TRANSCRIPT_SOURCE_MAX_LENGTH = 16 * 1024 * 1024

/** Values visited before a tool input is abandoned as unmeasurable. */
export const TRANSCRIPT_SOURCE_MAX_NODES = 100_000

/**
 * Length of the source, in UTF-16 code units, stopping as soon as `budget` is
 * passed. Counts characters rather than encoded bytes on purpose: UTF-8 never
 * uses fewer bytes than a string has code units, so a count over budget proves
 * the byte length is over budget too — and unlike encoding it allocates
 * nothing, which is the point when the thing being measured may be huge.
 *
 * Anything this cannot finish measuring counts as over budget. A tool input
 * that hides a megabyte under nine levels of nesting, or spreads itself over
 * more nodes than the cap allows, is refused rather than waved through at the
 * size of the part that was walked — an unmeasured subtree is not a small one.
 */
export function transcriptSourceLength(
  messages: readonly NativeChatMessage[],
  budget = TRANSCRIPT_SOURCE_MAX_LENGTH
): { length: number; overBudget: boolean } {
  let length = 0
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'text') {
        length += block.text.length
      } else if (block.type === 'tool-result') {
        length += block.output.length
      } else if (block.type === 'tool-call') {
        length += block.name.length
        if (typeof block.input === 'string') {
          length += block.input.length
        } else {
          const measured = measureValue(block.input, budget - length)
          length += measured.length
          if (measured.overBudget) {
            return { length, overBudget: true }
          }
        }
      } else if (block.type === 'image-ref') {
        length += (block.path ?? block.url ?? block.alt ?? '').length
      }
      if (length > budget) {
        return { length, overBudget: true }
      }
    }
  }
  return { length, overBudget: false }
}

/**
 * Measure a tool input's strings with an explicit stack: no recursion, no depth
 * limit, and every string accounted for at whatever depth it sits. Bounded by
 * the node cap and the remaining budget, and `seen` keeps a shared or cyclic
 * reference from being walked twice.
 */
function measureValue(root: unknown, remaining: number): { length: number; overBudget: boolean } {
  let length = 0
  let nodes = 0
  const stack: unknown[] = [root]
  const seen = new WeakSet<object>()
  while (stack.length > 0) {
    nodes += 1
    if (nodes > TRANSCRIPT_SOURCE_MAX_NODES) {
      return { length, overBudget: true }
    }
    const value = stack.pop()
    if (typeof value === 'string') {
      length += value.length
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      length += 8
    } else if (value !== null && typeof value === 'object') {
      if (seen.has(value)) {
        continue
      }
      seen.add(value)
      if (Array.isArray(value)) {
        for (const entry of value) {
          stack.push(entry)
        }
      } else {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          length += key.length
          stack.push(entry)
        }
      }
    }
    if (length > remaining) {
      return { length, overBudget: true }
    }
  }
  return { length, overBudget: false }
}

/**
 * Every payload this renderer would emit, complete and unclipped.
 *
 * The secret scan runs over these, not over the finished document: clipping a
 * tool result to its head can remove the closing `-----END …-----` of a PEM
 * block, and a delimiter-anchored rule stops matching a key that is still
 * half-present in the output. Scanning before the clip is what makes the gate
 * sound; the document is scanned afterwards as well.
 */
export function transcriptCompletePayloads(messages: readonly NativeChatMessage[]): string[] {
  const payloads: string[] = []
  for (const message of messages) {
    if (!ROLE_LABELS[message.role]) {
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'text') {
        payloads.push(block.text)
      } else if (block.type === 'image-ref') {
        payloads.push(block.path ?? block.url ?? block.alt ?? '')
      } else if (block.type === 'tool-call') {
        payloads.push(block.name, serializeToolInput(block.input).text)
      } else if (block.type === 'tool-result') {
        payloads.push(block.output)
      }
    }
  }
  return payloads.filter((payload) => payload.length > 0)
}

type BlockRender = { text: string; truncated: boolean }

function renderBlock(
  block: NativeChatBlock,
  sha256: (value: string) => string,
  clipPayloads: boolean
): BlockRender | null {
  if (block.type === 'text') {
    return block.text.trim() ? { text: block.text, truncated: false } : null
  }
  if (block.type === 'image-ref') {
    const reference = block.path ?? block.url ?? block.alt ?? '(image)'
    return { text: `Attached image: ${reference}`, truncated: false }
  }
  if (block.type === 'tool-call') {
    const { text, language } = serializeToolInput(block.input)
    const clip = clipUtf8(text, clipPayloads ? TRANSCRIPT_TOOL_INPUT_HEAD_BYTES : Infinity)
    const body = clip.clipped
      ? clip.text + transcriptTruncationMarker(transcriptByteLength(text), sha256(text))
      : clip.text
    const head = `Tool call: ${block.name}`
    return {
      text: body.trim() && body.trim() !== '{}' ? `${head}\n${fence(body, language)}` : head,
      truncated: clip.clipped
    }
  }
  if (block.type === 'tool-result') {
    const clip = clipUtf8(block.output, clipPayloads ? TRANSCRIPT_TOOL_OUTPUT_HEAD_BYTES : Infinity)
    const body = clip.clipped
      ? clip.text +
        transcriptTruncationMarker(transcriptByteLength(block.output), sha256(block.output))
      : clip.text
    const head = block.isError ? 'Tool error:' : 'Tool result:'
    return { text: body.trim() ? `${head}\n${fence(body, '')}` : head, truncated: clip.clipped }
  }
  return null
}

/**
 * Render a captured conversation into the Markdown document a person handoff
 * delivers. Throws — rather than clipping the document — when the result would
 * exceed `maxBytes`, so a recipient never receives a transcript that silently
 * stops mid-session.
 */
export function renderTranscriptMarkdown(
  messages: readonly NativeChatMessage[],
  options: TranscriptRenderOptions
): TranscriptRenderResult {
  const maxBytes = options.maxBytes ?? TRANSCRIPT_MAX_BYTES
  const clipPayloads = options.clipToolPayloads ?? true
  let truncatedBlocks = 0
  const sections: string[] = []
  let rendered = 0
  for (const message of messages) {
    const label = ROLE_LABELS[message.role]
    if (!label) {
      continue
    }
    const blocks = message.blocks
      .map((block) => renderBlock(block, options.sha256, clipPayloads))
      .filter((entry): entry is BlockRender => entry !== null)
    if (!blocks.length) {
      continue
    }
    truncatedBlocks += blocks.filter((entry) => entry.truncated).length
    rendered += 1
    sections.push(
      `## ${rendered}. ${label} — ${timeLabel(message.timestamp)}\n\n${blocks
        .map((entry) => entry.text)
        .join('\n\n')}`
    )
  }
  const header = [
    '# Session transcript',
    '',
    `- Agent: ${options.agent}`,
    ...(options.model ? [`- Model: ${options.model}`] : []),
    `- Session: ${options.sessionId}`,
    `- Captured at: ${options.capturedAt}`,
    `- Messages: ${rendered}${options.earlierMessagesOmitted ? ' (the most recent; earlier messages are not included)' : ''}`,
    ...(options.omittedRecords
      ? [
          `- Omitted records: ${options.omittedRecords} (unreadable or above the reader's record limit)`
        ]
      : []),
    `- Source digest: ${options.sourceDigest}`
  ].join('\n')
  const footer = [
    '---',
    '',
    ...(options.earlierMessagesOmitted
      ? [
          'This session was longer than one transcript file holds: it begins mid-session and the earlier messages are not included.',
          ''
        ]
      : []),
    ...(options.omittedRecords
      ? [
          `${options.omittedRecords} record${options.omittedRecords === 1 ? '' : 's'} in this session could not be read, or exceeded the reader's per-record limit, and ${options.omittedRecords === 1 ? 'is' : 'are'} missing from the middle of this transcript. It is not a continuous record of the session.`,
          ''
        ]
      : []),
    truncatedBlocks
      ? `${truncatedBlocks} tool payload${truncatedBlocks === 1 ? ' was' : 's were'} clipped to their head (${TRANSCRIPT_TOOL_INPUT_HEAD_BYTES} bytes for a call's input, ${TRANSCRIPT_TOOL_OUTPUT_HEAD_BYTES} bytes for a result's output). Each clipped payload carries its full byte length and digest inline.`
      : 'No payload in this transcript was clipped; every message is complete.',
    '',
    'Redacted for secrets before delivery. Reasoning and system messages are not included.'
  ].join('\n')
  const markdown = `${[header, ...sections, footer].join('\n\n')}\n`
  const bytes = transcriptByteLength(markdown)
  if (bytes > maxBytes) {
    throw new TranscriptTooLargeError(bytes, maxBytes)
  }
  return { markdown, messageCount: rendered, truncatedBlocks, bytes }
}
