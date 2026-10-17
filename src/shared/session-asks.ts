// A session's to-do list, for any kind of work: the person's own asks, in order. Agents rarely
// publish a task list (none did in 3 days of Claude and Codex sessions measured 2026-09-22), but
// every session has asks. Mechanical: the transcript only, cached per message, no model calls.

import { isTextBlock, type NativeChatMessage } from './native-chat-types'
import { sessionGoalFromPrompt } from './session-goal'

/** Fewer words than this is a reply ("yes", "continue"), not a new ask. */
export const SESSION_ASK_MIN_WORDS = 4
/** A short turn opening with one of these is a reply too ("ok done logged in"). */
const REPLY_OPENERS =
  /^(?:ok(?:ay)?|k|yes|yeah|yep|sure|done|continue|go ahead|thanks|thank you|great|perfect|nice|cool|agreed|approved|lgtm)\b/i
const REPLY_MAX_WORDS = 6
/** A prompt this soon after the one before it is still the same thought, not queued work. */
const FOLLOW_ON_WINDOW_MS = 3 * 60_000
/** The same text again this soon is one prompt recorded twice, not a repeat ask. */
const DUPLICATE_WINDOW_MS = 5_000
export const SESSION_ASK_TITLE_MAX = 90
const LEADING_FILLER = [
  /^(?:hey|hi|hello|so|um+|hm+|alright|ok(?:ay)?|yeah|also|but|and)[,\s]+/i,
  /^i think(?: that)?\s+/i,
  /^(?:can|could|would|will) (?:you|we)(?: please)?\s+/i,
  /^please\s+/i,
  /^i(?:'d| would)? (?:want|need|like)(?: you)? to\s+/i,
  /^let'?s\s+/i
]
const TRAILING_FILLER = /[\s,]+(?:please|pls|thanks|thank you)[.!?]*$/i

/** A short, readable name for an ask: its first clause without "can you" / "please". */
export function sessionAskTitle(full: string): string {
  const flat = full.replace(/\s+/g, ' ').trim()
  let clause = flat.split(/(?<=[.!?])\s|:\s|\s[-–—]\s/)[0]?.trim() || flat
  for (let pass = 0; pass < 3; pass += 1) {
    for (const pattern of LEADING_FILLER) {
      clause = clause.replace(pattern, '')
    }
  }
  clause =
    clause
      .replace(TRAILING_FILLER, '')
      .replace(/[.:;,]+$/, '')
      .trim() || flat
  if (clause.length > SESSION_ASK_TITLE_MAX) {
    const cut = clause.slice(0, SESSION_ASK_TITLE_MAX - 1)
    clause = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trimEnd()}…`
  }
  return clause.charAt(0).toUpperCase() + clause.slice(1)
}

function isReply(line: string, words: number): boolean {
  return words < SESSION_ASK_MIN_WORDS || (words <= REPLY_MAX_WORDS && REPLY_OPENERS.test(line))
}

export type SessionAsk = {
  /** The message index that made the ask; stable while the transcript grows. */
  index: number
  at: number | null
  /** A short name for the ask ("Get unlimited toggle PR ready for deploy"). */
  title: string
  /** The ask without pastes or harness text, for a hover. */
  full: string
  /** Short replies the person sent after it ("yes", "continue"), folded into it. */
  replies: number
  /** Whether the AI said or did anything after it. */
  answered: boolean
}

type ParsedPrompt = { title: string; full: string; reply: boolean } | null

const promptByMessage = new WeakMap<NativeChatMessage, ParsedPrompt>()

function parsePrompt(message: NativeChatMessage): ParsedPrompt {
  if (promptByMessage.has(message)) {
    return promptByMessage.get(message) ?? null
  }
  const text = message.blocks
    .flatMap((block) => (isTextBlock(block) ? [block.text] : []))
    .join('\n')
  const goal = sessionGoalFromPrompt(text)
  const parsed: ParsedPrompt = goal
    ? {
        title: sessionAskTitle(goal.full),
        full: goal.full,
        reply: isReply(goal.line, goal.line.split(/\s+/).filter(Boolean).length)
      }
    : null
  promptByMessage.set(message, parsed)
  return parsed
}

/** The person's asks, oldest first; replies too short to be an ask fold into the one before. */
export function sessionAsks(messages: readonly NativeChatMessage[]): SessionAsk[] {
  const asks: SessionAsk[] = []
  messages.forEach((message, index) => {
    if (message.role === 'assistant' || message.role === 'tool') {
      const last = asks.at(-1)
      if (last) {
        last.answered = true
      }
      return
    }
    if (message.role !== 'user') {
      return
    }
    const prompt = parsePrompt(message)
    if (!prompt) {
      return
    }
    const last = asks.at(-1)
    const since =
      last?.at !== null && last?.at !== undefined && message.timestamp !== null
        ? message.timestamp - last.at
        : null
    // Why: Codex records a prompt both as a response item and as an event.
    if (
      last &&
      last.full === prompt.full &&
      (!last.answered || (since !== null && since <= DUPLICATE_WINDOW_MS))
    ) {
      return
    }
    // Why: a quick prompt before the AI replied continues the ask; work queued later is its own.
    const followsOn = !last?.answered && (since === null || since <= FOLLOW_ON_WINDOW_MS)
    if (last && (prompt.reply || followsOn)) {
      last.replies += 1
      last.answered = false
      return
    }
    asks.push({
      index,
      at: message.timestamp,
      title: prompt.title,
      full: prompt.full,
      replies: 0,
      answered: false
    })
  })
  return asks
}

/** Which ask a message belongs to: the latest ask at or before it; -1 before the first. */
export function askIndexForMessage(asks: readonly SessionAsk[], messageIndex: number): number {
  let found = -1
  for (let position = 0; position < asks.length; position += 1) {
    if (asks[position]!.index > messageIndex) {
      break
    }
    found = position
  }
  return found
}
