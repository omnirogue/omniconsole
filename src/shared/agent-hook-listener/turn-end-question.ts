/**
 * A question an agent leaves in its turn's own words instead of a question tool. Sign-in links
 * (AirTop live views, OAuth/login pages) and explicit sign-in waits always count; a plain question
 * the final message ends on counts only while Settings › Sessions turns that on
 * (`sessionQuestions.turnEndQuestions`, off by default), since every such turn would otherwise
 * show as waiting. Both ride the finished turn as an async ask (`{ delivery: 'async', asyncQuestions }`),
 * so Needs you and OmniOS Questions list them like Codex's `request_user_input_async`.
 */

import { AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH } from '../agent-status-types'
import {
  MAX_QUESTION,
  serializeCodexAsyncAskEnvelope,
  type CodexAsyncAskEnvelope
} from '../codex-async-question'
import { readFirstString } from './interactive-tool'
import { readCurrentTurnAssistantText } from './turn-end-transcript'
import {
  AUTH_REQUEST,
  HANDOFF_WAIT,
  mayHandOverSignIn,
  signInLinks,
  type SignInLink
} from './turn-end-sign-in-links'

type Questions = CodexAsyncAskEnvelope['asyncQuestions']

const DIRECT_ASK =
  /\b(?:would you|do you|should i|should we|which|want me to|shall i|can you|could you|let me know|confirm|prefer|choose|ready to|what should)\b/i
// Why its own test: AUTH_REQUEST also covers "please approve", which is no sign-in.
const SIGN_IN_WORDS = /\b(?:(?:re-?)?(?:sign|log)[\s-]?(?:in|on)|login|oauth|authenticat\w*)\b/i
const SIGN_IN_OPTIONS = [{ label: 'Signed in — continue' }, { label: 'Need fresh sign-in link' }]

let generalQuestionsEnabled: () => boolean = () => false

/** Main wires Settings › Sessions here; a relay keeps the default: general questions off. */
export function setTurnEndGeneralQuestionsResolver(resolver: () => boolean): void {
  generalQuestionsEnabled = resolver
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

function clip(text: string, room: number): string {
  return text.length > room ? `${text.slice(0, room - 1)}…` : text
}

function signInQuestions(links: SignInLink[], context: string): Questions {
  const lines = links
    .map(({ label, url }) => (label ? `${label}: ${url}` : url))
    // Why drop rather than cut: a link cut short is a broken link.
    .filter((line) => line.length + 40 <= MAX_QUESTION)
  const questions: string[] = []
  let current = lines.length === 1 ? 'Sign in at this link:' : 'Sign in at these links:'
  for (const line of lines) {
    if (current.length + 1 + line.length > MAX_QUESTION) {
      questions.push(current)
      current = 'More sign-in links:'
    }
    current = `${current}\n${line}`
  }
  questions.push(current)
  const room = MAX_QUESTION - questions[0]!.length - 2
  if (context && room > 40) {
    questions[0] = `${questions[0]}\n\n${clip(context, room)}`
  }
  return questions
    .filter((question) => question.includes('://'))
    .map((question) => ({ question, multiSelect: false as const, options: SIGN_IN_OPTIONS }))
}

/** A final message that asks the person to sign in and waits on it, with no link to open. */
function signInWait(final: string): Questions {
  if (!SIGN_IN_WORDS.test(final) || !AUTH_REQUEST.test(final) || !HANDOFF_WAIT.test(final)) {
    return []
  }
  const question = `Sign in, then continue:\n\n${paragraphsOf(final).slice(-2).join('\n\n')}`
  return [{ question: clip(question, MAX_QUESTION), multiSelect: false, options: SIGN_IN_OPTIONS }]
}

/** The text a reader sees as the asker's own: code spans and quoted words are examples. */
function ownWords(paragraph: string): string {
  return paragraph
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
    .replace(/[\s*_~]+$/, '')
}

/** The question the final message ends on, with the paragraph before it when it is short. */
export function directQuestion(final: string): string | undefined {
  // Why: an odd fence count means the message ends inside a code block.
  if ((final.match(/```/g)?.length ?? 0) % 2 === 1) {
    return undefined
  }
  const paragraphs = paragraphsOf(final)
  const last = paragraphs.at(-1) ?? ''
  const bare = ownWords(last)
  if (
    !bare.endsWith('?') ||
    (bare.length < 15 && !DIRECT_ASK.test(bare)) ||
    /^(?:#{1,6}\s|```|\$\s|>)/.test(last) ||
    (!DIRECT_ASK.test(last) && last.length > 600)
  ) {
    return undefined
  }
  const before = paragraphs.length > 1 && last.length < 160 ? paragraphs.at(-2)! : ''
  const room = MAX_QUESTION - last.length - 2
  if (!before || room <= 40) {
    return last.slice(0, MAX_QUESTION)
  }
  return `${before.length > room ? `…${before.slice(before.length - room + 1)}` : before}\n\n${last}`
}

/**
 * The async ask a finished turn leaves in its own words, serialized as a status prompt, or
 * undefined. Sign-in links count only while the final message still asks for or waits on them.
 */
export function detectTurnEndAsyncAsk(
  turnText: string,
  lastAssistantMessage: string | undefined,
  options: { generalQuestions: boolean; nowMs?: number }
): string | undefined {
  const final = (lastAssistantMessage?.trim() || paragraphsOf(turnText).at(-1)) ?? ''
  if (!final) {
    return undefined
  }
  const finalWaits = AUTH_REQUEST.test(final) || HANDOFF_WAIT.test(final)
  const links = signInLinks(
    turnText.includes(final) ? turnText : [turnText, final].filter(Boolean).join('\n\n'),
    finalWaits
  )
  const linkInFinal = links.some((link) => final.includes(link.url))
  let questions: Questions = []
  if (links.length > 0 && (finalWaits || linkInFinal)) {
    questions = signInQuestions(links, linkInFinal ? '' : final)
  }
  if (questions.length === 0 && links.length === 0) {
    questions = signInWait(final)
  }
  if (questions.length === 0 && options.generalQuestions) {
    const question = directQuestion(final)
    questions = question ? [{ question, multiSelect: false, options: [] }] : []
  }
  if (questions.length === 0) {
    return undefined
  }
  const askedAt = options.nowMs ?? Date.now()
  return serializeCodexAsyncAskEnvelope(
    { delivery: 'async', asyncQuestions: questions.map((question) => ({ ...question, askedAt })) },
    AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH
  )
}

/** The Stop hook's turn-end async ask, or undefined (an interrupted turn asks nothing). */
export function turnEndAsyncAskPrompt(
  hookPayload: Record<string, unknown>,
  lastAssistantMessage: string | undefined
): string | undefined {
  const generalQuestions = generalQuestionsEnabled()
  const final = lastAssistantMessage?.trim()
  // Why a pre-check: most turns end on neither, and the transcript read is the costly part.
  if (
    hookPayload.is_interrupt === true ||
    (final && !mayHandOverSignIn(final) && !(generalQuestions && final.includes('?')))
  ) {
    return undefined
  }
  const transcriptPath = readFirstString(hookPayload, ['transcript_path', 'transcriptPath'])
  return detectTurnEndAsyncAsk(
    readCurrentTurnAssistantText(transcriptPath, lastAssistantMessage),
    lastAssistantMessage,
    { generalQuestions }
  )
}
