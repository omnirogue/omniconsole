import type {
  AskOption,
  AskPrompt,
  AskQuestion,
  InteractiveQuestionParser
} from './native-chat-ask-types'
import { isInterruptedStatusMessage, type NativeChatMessage } from './native-chat-types'
import {
  CODEX_ASYNC_QUESTION_TOOL,
  codexAsyncAskEnvelope,
  quotedQuestionLine
} from './codex-async-question'
import { parseAskOptions } from './native-chat-ask-options'
import { GEMINI_ASK_USER_TOOL, parseGeminiAskUser } from './native-chat-gemini-ask'
import { HERMES_CLARIFY_TOOL, parseHermesClarify } from './native-chat-hermes-ask'
import { unwrapOptionOnlyAsk } from './native-chat-option-only-ask'

export type { AskOption, AskPrompt, AskQuestion, InteractiveQuestionParser }

const QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>()

/** Stable cross-platform identity for one canonical question prompt. */
export function nativeChatAskDismissKey(prompt: AskPrompt | null): string | null {
  return prompt ? `question:${JSON.stringify(prompt.questions)}` : null
}

export function registerQuestionTool(toolName: string, parser: InteractiveQuestionParser): void {
  QUESTION_TOOL_PARSERS.set(toolName, parser)
}

function parseQuestionsShape(input: unknown, omp = false): AskPrompt | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const rawQuestions = (input as { questions?: unknown }).questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return null
  }
  const questions: AskQuestion[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const question = raw as Record<string, unknown>
    const text = typeof question.question === 'string' ? question.question : ''
    const options = parseAskOptions(question.options)
    if (text || options.length > 0) {
      questions.push({
        question: text,
        header: typeof question.header === 'string' ? question.header : undefined,
        // Why multi_select: Kimi Code's AskUserQuestion spells it that way.
        multiSelect: omp
          ? question.multi === true
          : question.multiSelect === true || question.multi_select === true,
        options,
        ...(typeof question.askedAt === 'number' && Number.isFinite(question.askedAt)
          ? { askedAt: question.askedAt }
          : {})
      })
    }
  }
  if (questions.length === 0) {
    return null
  }
  return (input as { delivery?: unknown }).delivery === 'async'
    ? { questions, delivery: 'async' }
    : { questions }
}

for (const name of ['AskUserQuestion', 'ask_user_question', 'askUserQuestion']) {
  QUESTION_TOOL_PARSERS.set(name, parseQuestionsShape)
}
QUESTION_TOOL_PARSERS.set('ask', (input) => parseQuestionsShape(input, true))
function parseAsyncAsk(input: unknown): AskPrompt | null {
  const envelope = codexAsyncAskEnvelope(input)
  return envelope
    ? parseQuestionsShape({ questions: envelope.asyncQuestions, delivery: 'async' })
    : null
}
QUESTION_TOOL_PARSERS.set(CODEX_ASYNC_QUESTION_TOOL, parseAsyncAsk)

// Why exclusive: these inputs can pass the canonical fallback, but a question their parser
// refuses (free text, no choices) must stay in the terminal, not become a card.
const EXCLUSIVE_QUESTION_TOOL_PARSERS = new Map<string, InteractiveQuestionParser>([
  [GEMINI_ASK_USER_TOOL, parseGeminiAskUser],
  [HERMES_CLARIFY_TOOL, parseHermesClarify]
])

function parseToolInput(toolName: string | undefined, rawInput: unknown): AskPrompt | null {
  const input = unwrapOptionOnlyAsk(rawInput)
  if (input !== rawInput) {
    // Why: an option-only question is answered by selector keys only, never as an async message.
    const prompt = (toolName ? EXCLUSIVE_QUESTION_TOOL_PARSERS.get(toolName) : undefined)?.(input)
    const parsed = prompt === undefined ? parseQuestionsShape(input) : prompt
    return parsed ? { questions: parsed.questions } : null
  }
  // Why first: an open async question outlives its tool call, so the status's tool is another one.
  if ((input as { asyncQuestions?: unknown } | null)?.asyncQuestions !== undefined) {
    return parseAsyncAsk(input)
  }
  const exclusive = toolName ? EXCLUSIVE_QUESTION_TOOL_PARSERS.get(toolName) : undefined
  if (exclusive) {
    return exclusive(input)
  }
  const parser = toolName ? QUESTION_TOOL_PARSERS.get(toolName) : undefined
  return (parser ? parser(input) : null) ?? parseQuestionsShape(input)
}

export function parseAskFromStatus(
  interactivePrompt: string | undefined | null,
  toolName?: string
): AskPrompt | null {
  if (!interactivePrompt) {
    return null
  }
  try {
    return parseToolInput(toolName, JSON.parse(interactivePrompt))
  } catch {
    return null
  }
}

/** Resolve the newest question tool that has not received its FIFO tool result.
 *  Transcript replay parses each tool-call through the same registered-parser +
 *  canonical-shape fallback as live status, so a question tool that rendered
 *  live cannot vanish from pending state after a reconnect/replay. */
export function extractPendingAsk(messages: readonly NativeChatMessage[]): AskPrompt | null {
  let pending: AskPrompt | null = null
  const outstanding: (AskPrompt | null)[] = []
  for (const message of messages) {
    // A new user turn (or an interrupt row) ends the turn that owns whatever
    // calls are still in flight: their results never arrive, and `tool_use_id`
    // is dropped at decode time so those orphans can never be matched by id.
    // Without this reset one orphan shifts the result FIFO for the rest of the
    // transcript and strands an answered ask as a permanent card over the
    // composer (#11761). Claude's tool-result turns decode as role 'tool'.
    if (message.role === 'user' || isInterruptedStatusMessage(message)) {
      outstanding.length = 0
      pending = null
    }
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        const parsed = parseToolInput(block.name, block.input)
        if (parsed) {
          pending = parsed
        }
        outstanding.push(parsed)
      } else if (block.type === 'tool-result' && outstanding.length > 0) {
        const resolved = outstanding.shift()
        if (resolved && resolved === pending) {
          pending = null
        }
      }
    }
  }
  return pending
}

/** Identify a repeated question by its transcript occurrence, including resolved calls. */
export function latestNativeChatAskOccurrence(
  messages: readonly NativeChatMessage[],
  prompt: AskPrompt
): string | null {
  const key = nativeChatAskDismissKey(prompt)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex]!
      if (
        block.type === 'tool-call' &&
        nativeChatAskDismissKey(parseToolInput(block.name, block.input)) === key
      ) {
        return JSON.stringify([message.id, blockIndex])
      }
    }
  }
  return null
}

/** Prefers live status and consults transcript history only after its read settles. */
export function resolveNativeChatAsk(args: {
  liveAsk: AskPrompt | null
  messages: readonly NativeChatMessage[]
  transcriptSettled: boolean
}): AskPrompt | null {
  return args.liveAsk ?? (args.transcriptSettled ? extractPendingAsk(args.messages) : null)
}

/** One question's chosen answer, normalized for delivery: the selected option
 *  indices (in option order) plus any free-text "other" answer. Index-based (not
 *  label text) so the answer can be delivered by the selector's stable option
 *  number — see `buildAskAnswerKeys`. */
export type AskAnswerSelection = { indices: number[]; other?: string }

/** A single keystroke group to write to the agent PTY. `raw` bytes (option
 *  numbers, Enter, arrows) are written verbatim as keystrokes; `text` is a
 *  free-text answer the caller runs through its paste sanitizer before writing. */
export type AskAnswerKeyGroup =
  | {
      raw: string
      /** The dialog step that must be on screen before this key (option-only selectors). */
      screen?: number | 'submit'
    }
  | { text: string }

/** True when this question is answered (a picked option or typed free text). */
function isAnswered(sel: AskAnswerSelection | undefined): boolean {
  return (sel?.indices.length ?? 0) > 0 || (sel?.other ?? '').trim().length > 0
}

/** The picked labels + trimmed free text for one question, in option order. */
function answerLabels(question: AskQuestion, sel: AskAnswerSelection | undefined): string[] {
  const labels = (sel?.indices ?? [])
    .map((i) => question.options[i]?.label ?? '')
    .filter((l) => l.length > 0)
  const other = (sel?.other ?? '').trim()
  return other ? [...labels, other] : labels
}

/** Build the human-readable answer text: one line per question, in question
 *  order, each the selected label(s) + free text joined by ", ". Empty answers
 *  stay empty lines so N lines always == N questions. Used for agents whose
 *  question tool commits a pasted answer (not Claude's arrow-navigate selector). */
export function formatAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): string {
  return prompt.questions.map((q, i) => answerLabels(q, selections[i]).join(', ')).join('\n')
}

// Claude's AskUserQuestion is an arrow-navigate selector: a bare Enter commits
// the HIGHLIGHTED default (the first option), and pasted label text does not move
// the highlight — so answering by label silently delivered every non-first pick
// as the first option (STA-1860). Instead we drive the selector by each option's
// stable 1-based number (which matches the card's badge), the marker it commits
// on. Right-arrow steps to the next question / the Submit tab. Verified live
// against Claude Code's TUI; groups are written spaced apart (see the senders)
// because a navigation keystroke batched with Enter commits before the selector
// has applied it.
const ASK_ENTER = '\r'
const ASK_NEXT_TAB = '\x1b[C'
const ASK_ADD_NOTES = 'n'
const ASK_PREVIOUS_ROW = '\x1b[A'
const ASK_NEXT_ROW = '\x1b[B'
const ASK_NOTES = '\t'

/** Claude draws a single-select question whose options carry `preview` text in
 *  a side-by-side layout. There an option number only MOVES the highlight and
 *  Enter selects it; there is no "Type something" row, free text is a note
 *  (`n`) on the highlighted option. Verified live against Claude Code 2.1.278. */
export function isClaudePreviewQuestion(question: AskQuestion): boolean {
  return !question.multiSelect && question.options.some((option) => Boolean(option.preview))
}

/** Build the ordered keystroke groups that answer a Claude Code AskUserQuestion.
 *  Each group is written a step apart so the selector applies it before the next.
 *
 *  - single-select pick  → the option number (selects AND commits; in a
 *    multi-question prompt it auto-advances to the next question)
 *  - free-text answer    → the "Type something" row number, the text, then Enter
 *  - multi-select        → each option number TOGGLES its checkbox, then a step
 *    to the next tab; free text is typed on the "Type something" row, reached
 *    with Down arrows from the first row, and left through the "Next" row
 *  - a multi-question prompt (and a lone multi-select) finishes on a Submit
 *    confirmation, so it ends with one Enter
 *
 *  (Option counts are ≤ the tool's cap of a few, so single-digit numbers always
 *  address every row.) */
export function buildAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const questions = prompt.questions
  const multiQuestion = questions.length > 1
  const groups: AskAnswerKeyGroup[] = []

  questions.forEach((q, qi) => {
    const sel = selections[qi]
    const other = (sel?.other ?? '').trim()
    const typeSomething = String(q.options.length + 1)

    if (isClaudePreviewQuestion(q)) {
      const picked = sel?.indices[0]
      if (picked !== undefined || other) {
        // Why digit then Enter: in this layout the digit alone commits nothing, so a
        // multi-question answer used to leave every question after the first unanswered.
        groups.push({ raw: String((picked ?? 0) + 1) })
        if (other) {
          groups.push({ raw: ASK_ADD_NOTES }, { text: other })
        }
        groups.push({ raw: ASK_ENTER })
      } else if (multiQuestion) {
        groups.push({ raw: ASK_NEXT_TAB })
      }
    } else if (q.multiSelect) {
      for (const i of sel?.indices ?? []) {
        groups.push({ raw: String(i + 1) })
      }
      if (other) {
        // Why not the row number: in a multi-select its number only ticks the empty
        // "Type something" box without focusing it, so the text went nowhere and the
        // Enter after it un-ticked the highlighted option. Walk the highlight down from
        // the first row instead; typing ticks the row. Enter there would un-tick it, so
        // leave through the "Next"/"Submit" row just below. Verified live against
        // Claude Code 2.1.280.
        for (let row = 0; row < q.options.length; row += 1) {
          groups.push({ raw: ASK_NEXT_ROW })
        }
        groups.push({ text: other }, { raw: ASK_NEXT_ROW }, { raw: ASK_ENTER })
      } else {
        // A multi-select never auto-advances; step to the next tab (the Submit tab
        // when this is the last question).
        groups.push({ raw: ASK_NEXT_TAB })
      }
    } else if (other) {
      // Single-select can only carry one value, so route any answer that
      // includes free text through the "Type something" row as one string.
      groups.push(
        { raw: typeSomething },
        { text: answerLabels(q, sel).join(', ') },
        { raw: ASK_ENTER }
      )
    } else if ((sel?.indices.length ?? 0) > 0) {
      groups.push({ raw: String(sel!.indices[0]! + 1) })
    } else if (multiQuestion) {
      // Unanswered question in a multi-question prompt: step past it.
      groups.push({ raw: ASK_NEXT_TAB })
    }
  })

  const endsOnSubmitTab =
    multiQuestion || (questions.length === 1 && questions[0]!.multiSelect === true)
  if (endsOnSubmitTab && groups.length > 0) {
    groups.push({ raw: ASK_ENTER })
  }
  return groups
}

/** Build keystrokes for Codex's request_user_input overlay.
 *
 * Unlike Claude, Codex submits on the final option digit and attaches free text
 * as notes to the highlighted row. The overlay starts on the first row, so note
 * answers move to the target without committing, open notes with Tab, then
 * submit with Enter. */
export function buildCodexAskAnswerKeys(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskAnswerKeyGroup[] {
  const groups: AskAnswerKeyGroup[] = []
  let hasUnanswered = false

  prompt.questions.forEach((question, questionIndex) => {
    const selection = selections[questionIndex]
    const selectedIndex = selection?.indices[0]
    const note = (selection?.other ?? '').trim()

    if (note) {
      const targetIndex = selectedIndex ?? question.options.length
      const rowCount = question.options.length + 1
      const nextSteps = targetIndex
      const previousSteps = rowCount - targetIndex
      const usePrevious = previousSteps < nextSteps
      const navigationKey = usePrevious ? ASK_PREVIOUS_ROW : ASK_NEXT_ROW
      const navigationSteps = usePrevious ? previousSteps : nextSteps
      for (let index = 0; index < navigationSteps; index += 1) {
        groups.push({ raw: navigationKey })
      }
      groups.push({ raw: ASK_NOTES }, { text: note }, { raw: ASK_ENTER })
      return
    }

    if (selectedIndex !== undefined) {
      groups.push({ raw: String(selectedIndex + 1) })
      return
    }

    hasUnanswered = true
    groups.push({ raw: '\x7f' })
    if (questionIndex < prompt.questions.length - 1) {
      groups.push({ raw: ASK_NEXT_TAB })
    } else {
      groups.push({ raw: ASK_ENTER })
    }
  })

  // Codex opens a confirmation after the last question when any were skipped;
  // Proceed is highlighted by default, so one Enter submits the partial answer.
  if (hasUnanswered) {
    groups.push({ raw: ASK_ENTER })
  }
  return groups
}

/** An async question's answer as one message, in Codex's own reply layout (`> question`, answer). */
export function formatAsyncAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): string {
  return prompt.questions
    .map((q, i) => ({ q, answer: answerLabels(q, selections[i]).join(', ') }))
    .filter(({ answer }) => answer.length > 0)
    .map(({ q, answer }) => `> ${quotedQuestionLine(q.question)}\n\n${answer}`)
    .join('\n\n')
}

/** The questions `formatAsyncAskAnswer` writes no line for: skipped in the card. */
export function asyncAskQuestionsLeftOut(
  prompt: AskPrompt,
  selections: AskAnswerSelection[]
): AskQuestion[] {
  return prompt.questions.filter((q, i) => answerLabels(q, selections[i]).length === 0)
}

/** Whether any question in `selections` carries an answer worth submitting. */
export function hasAskAnswer(prompt: AskPrompt, selections: AskAnswerSelection[]): boolean {
  return prompt.questions.some((_, i) => isAnswered(selections[i]))
}
