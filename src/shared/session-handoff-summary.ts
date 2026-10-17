import type { NativeChatMessage } from './native-chat-types'

export const SESSION_HANDOFF_SUMMARY_MAX_CHARS = 20_000
const ANSWER_HEADING = '## Final answer from the conversation'

/** The last thing the conversation's agent said in prose; null when it never answered. */
export function finalAssistantAnswer(
  messages: readonly NativeChatMessage[]
): NativeChatMessage | null {
  for (const message of messages.toReversed()) {
    const text = message.role === 'assistant' ? assistantProse(message) : ''
    if (text) {
      return message
    }
  }
  return null
}

/** The sender's own words: a note equal to the plan's title is its notation, unless it was typed. */
export function authoredHandoffNote(rule: {
  note: string
  noteAuthored?: true
  taskTitle: string
  sessionLabel: string
}): string {
  const notation = rule.note === rule.taskTitle || rule.note === rule.sessionLabel
  return rule.noteAuthored || !notation ? rule.note : ''
}

/** What the person typed, without the wrappers a CLI puts around pasted or injected text. */
export function personWords(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content\b[^>]*>/g, '')
    .trim()
}

/** What the person first asked the conversation for; null when it never had a person's message. */
export function firstPersonAsk(messages: readonly NativeChatMessage[]): NativeChatMessage | null {
  return (
    messages.find((message) => message.role === 'user' && personWords(assistantProse(message))) ??
    null
  )
}

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
const clipped = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/**
 * The title and description a person reads first. The plan only knows its own notation
 * (`👥 review ×2 ↩`), which tells a reviewer nothing, so they are written from the conversation:
 * what was asked, what came back, and the sender's own words when they wrote any.
 */
export function buildSessionHandoffRequest(args: {
  relationship: 'review' | 'handoff'
  /** What the sender typed; empty when the note is only the plan's notation. */
  authoredNote: string
  asked: string | null
  finalAnswer: string | null
  fallbackTitle: string
}): { title: string; description: string } {
  const asked = args.asked?.trim() ?? ''
  const answer = args.finalAnswer?.trim() ?? ''
  const lead =
    args.relationship === 'review'
      ? 'Please review this work and reply with approve or the changes you want.'
      : 'This work is handed over to you; you own it from here.'
  const description = [
    args.authoredNote.trim() || lead,
    asked ? `**What was asked**\n\n${clipped(asked, 1500)}` : '',
    answer ? `**Where it ended**\n\n${clipped(answer, 3000)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  const subject = asked ? oneLine(asked, 120) : args.fallbackTitle
  return {
    title: oneLine(`${args.relationship === 'review' ? 'Review' : 'Hand off'}: ${subject}`, 160),
    description: clipped(description, 8000)
  }
}

const WRITE_TOOLS =
  /^(write|create|edit|multiedit|notebookedit|str_replace_editor|create_file|write_file|edit_file|apply_patch)$/i
const PATCH_FILE = /^\*\*\* (?:Add|Update) File: (.+)$/gm

function writtenBy(name: string, input: unknown): string[] {
  if (!WRITE_TOOLS.test(name)) {
    return []
  }
  if (typeof input === 'string') {
    return [...input.matchAll(PATCH_FILE)].map((match) => match[1]!.trim())
  }
  const fields = (input ?? {}) as Record<string, unknown>
  const direct = fields.file_path ?? fields.filePath ?? fields.path
  const patch = fields.patch ?? fields.input
  return [
    ...(typeof direct === 'string' ? [direct] : []),
    ...(typeof patch === 'string' ? [...patch.matchAll(PATCH_FILE)].map((m) => m[1]!.trim()) : [])
  ]
}

/**
 * The files this conversation itself wrote or edited, most recent last, as the history names
 * them. It is what "work files" means when no stage produced a manifest: never a directory
 * listing, never the workspace's other changes.
 */
export function conversationWrittenFiles(messages: readonly NativeChatMessage[]): string[] {
  return conversationWrittenFileEntries(messages).map((entry) => entry.path)
}

/** The same files, each with the index of the latest message that wrote it. */
export function conversationWrittenFileEntries(
  messages: readonly NativeChatMessage[]
): { path: string; messageIndex: number }[] {
  const seen = new Map<string, number>()
  messages.forEach((message, messageIndex) => {
    for (const block of message.blocks) {
      const paths =
        block.type === 'tool-call'
          ? writtenBy(block.name, block.input)
          : block.type === 'tool-result' && block.editPatch?.filePath
            ? [block.editPatch.filePath]
            : []
      for (const path of paths.filter(Boolean)) {
        seen.delete(path)
        seen.set(path, messageIndex)
      }
    }
  })
  return [...seen].map(([path, messageIndex]) => ({ path, messageIndex }))
}

/** A file name a person can read: the topic and when it was sent, never a request id. */
export type ReadablePackageFileKind = 'Summary' | 'Conversation transcript'

export function readablePackageFileName(
  kind: ReadablePackageFileKind,
  topic: string,
  at: Date
): string {
  const subject = topic
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._()-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 60)
    .trim()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${kind}${subject ? ` - ${subject}` : ''} - ${stamp}.md`
}

export function assistantProse(message: NativeChatMessage): string {
  return message.blocks
    .map((block) => (block.type === 'text' ? block.text.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The summary a person receives: what the plan stated (its title and each finished stage's
 * result), then the conversation's own final answer. A handoff-only plan has no stage results,
 * so without the answer the summary was the title alone.
 */
export function buildSessionHandoffSummary(args: {
  stated: string
  finalAnswer: string | null
}): string {
  const stated = args.stated.trim()
  const answer = args.finalAnswer?.trim() ?? ''
  // Why: an Agent stage's result is often the same text; it is not said twice.
  if (!answer || stated.includes(answer)) {
    return stated.slice(0, SESSION_HANDOFF_SUMMARY_MAX_CHARS)
  }
  const head = `${stated.slice(0, SESSION_HANDOFF_SUMMARY_MAX_CHARS / 2)}\n\n${ANSWER_HEADING}\n\n`
  const room = SESSION_HANDOFF_SUMMARY_MAX_CHARS - head.length
  // Why the tail: a long answer ends with its conclusion, which is what the next person needs.
  return `${head}${answer.length > room ? `…${answer.slice(answer.length - room + 1)}` : answer}`
}
