/**
 * Codex ≥0.157's default-mode question tool, `request_user_input_async`: the tool returns at once,
 * the turn keeps running (or ends), and the TUI parks the question behind "⌥+↑ to answer". Its
 * reply arrives as an ordinary user message, so a hook status carries the open questions as a
 * `{ delivery: 'async', asyncQuestions }` prompt until Codex takes the prompt that answers them.
 * The turn that asked still ends `done`: Codex idles at its composer, and the question rides that
 * finished turn (see `asyncAskPendingInStatus`).
 *
 * Why `asyncQuestions`, not `questions`: a paired client from before this read any `questions`
 * array as a selector question and would type selector keys into Codex's composer; an unknown key
 * leaves it with no card at all.
 */

export const CODEX_ASYNC_QUESTION_TOOL = 'request_user_input_async'

/** Open questions kept per pane; Codex bounds each call the same way. */
export const MAX_OPEN_QUESTIONS = 8
const MAX_OPTIONS = 32
const MAX_LABEL = 512
export const MAX_QUESTION = 2_000

const REPLY_OPEN = '<send_user_message_question_reply>'
const REPLY_CLOSE = '</send_user_message_question_reply>'

export function isCodexAsyncQuestionTool(toolName: string | undefined): boolean {
  return toolName === CODEX_ASYNC_QUESTION_TOOL
}

type CanonicalQuestion = {
  question: string
  multiSelect: false
  options: { label: string }[]
  /** When the listener heard it asked: this asking's identity, the same across the turn's
   *  finished and children-running states, and new when Codex asks the same words again. */
  askedAt?: number
}

export type CodexAsyncAskEnvelope = { delivery: 'async'; asyncQuestions: CanonicalQuestion[] }

/** How far Codex's transcript had been written when a question was asked. */
export type CodexTranscriptMark = { path: string; offset: number }

/** Where one open question came from: the tool call, its index in that call, and when it was asked. */
type QuestionSource = { toolUseId: string | undefined; index: number; asked?: CodexTranscriptMark }

export type CodexAsyncAsk = {
  envelope: CodexAsyncAskEnvelope
  /** Parallel to `envelope.asyncQuestions`. */
  sources: QuestionSource[]
}

/** The pane is idle at the lead's composer: its turn is over (`done`), or only children run. */
export function codexTurnOverInStatus(status: {
  state: string
  workingMode?: string | null
}): boolean {
  return (
    status.state === 'done' || (status.state === 'working' && status.workingMode === 'monitoring')
  )
}

/**
 * Whether a question a status carries still waits on the person. A selector question holds the
 * agent (`waiting`/`blocked`); an async one rides the turn that asked it, so it waits on once that
 * turn is over. Why never while waiting: then a child's approval holds the pane, and a message
 * answer's Enter would land on that approval.
 */
export function asyncAskPendingInStatus(
  status: { state: string; workingMode?: string | null },
  delivery: 'async' | undefined
): boolean {
  return delivery === 'async'
    ? codexTurnOverInStatus(status)
    : status.state === 'waiting' || status.state === 'blocked'
}

function canonicalQuestions(raw: unknown): { question: CanonicalQuestion; index: number }[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const found: { question: CanonicalQuestion; index: number }[] = []
  raw.forEach((entry: unknown, index) => {
    const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
    // Why `question` too: a stored envelope is itself re-parsed through this.
    const text = record?.title ?? record?.question
    if (typeof text !== 'string' || text.trim().length === 0) {
      return
    }
    const options = Array.isArray(record?.options)
      ? record.options
          .map((option: unknown) =>
            typeof option === 'string' ? option : (option as { label?: unknown } | null)?.label
          )
          .filter(
            (label): label is string =>
              typeof label === 'string' && label.trim().length > 0 && label.length <= MAX_LABEL
          )
          .slice(0, MAX_OPTIONS)
          .map((label) => ({ label }))
      : []
    const askedAt = record?.askedAt
    found.push({
      question: {
        question: text.slice(0, MAX_QUESTION),
        multiSelect: false,
        options,
        ...(typeof askedAt === 'number' && Number.isFinite(askedAt) ? { askedAt } : {})
      },
      index
    })
  })
  return found
}

/** The tool's `{ questions: [{ title, options?: string[] }] }` input, or a stored envelope. */
export function codexAsyncAskEnvelope(input: unknown): CodexAsyncAskEnvelope | null {
  const record = input as { questions?: unknown; asyncQuestions?: unknown } | null
  const questions = canonicalQuestions(record?.asyncQuestions ?? record?.questions).map(
    (entry) => entry.question
  )
  return questions.length > 0 ? { delivery: 'async', asyncQuestions: questions } : null
}

/**
 * The envelope as a status carries it, within `maxLength`. Why not cut the JSON: a truncated one
 * parses to no card at all, so the latest questions, then the trailing options, are left out.
 */
export function serializeCodexAsyncAskEnvelope(
  envelope: CodexAsyncAskEnvelope,
  maxLength: number
): string | undefined {
  const serialize = (questions: CanonicalQuestion[]): string =>
    JSON.stringify({ delivery: 'async', asyncQuestions: questions })
  let questions = envelope.asyncQuestions
  let json = serialize(questions)
  while (json.length > maxLength && questions.length > 1) {
    questions = questions.slice(0, -1)
    json = serialize(questions)
  }
  let [first] = questions
  while (json.length > maxLength && first && first.options.length > 0) {
    first = { ...first, options: first.options.slice(0, -1) }
    json = serialize([first])
  }
  return json.length <= maxLength ? json : undefined
}

/** Adds one tool call's questions to what the pane already has open (Codex keeps both). */
export function addCodexAsyncAsk(
  open: CodexAsyncAsk | undefined,
  input: unknown,
  toolUseId: string | undefined,
  asked?: CodexTranscriptMark,
  now: number = Date.now()
): CodexAsyncAsk | undefined {
  const added = canonicalQuestions((input as { questions?: unknown } | null)?.questions)
  if (added.length === 0) {
    return open
  }
  const questions = [...(open?.envelope.asyncQuestions ?? [])]
  const sources = [...(open?.sources ?? [])]
  for (const { question, index } of added) {
    const same = questions.findIndex((existing) => existing.question === question.question)
    if (same !== -1) {
      questions.splice(same, 1)
      sources.splice(same, 1)
    }
    questions.push({ ...question, askedAt: now })
    sources.push({ toolUseId, index, ...(asked ? { asked } : {}) })
  }
  return keepQuestions(
    { envelope: { delivery: 'async', asyncQuestions: questions }, sources },
    questions.map((_, i) => i >= questions.length - MAX_OPEN_QUESTIONS)
  )!
}

/** What a user message answers through Codex's own reply block: `[toolUseId, index]` pairs, and
 *  the question texts the replies name (a fallback when the hook's call id differs). */
function repliedTo(promptText: string): { ids: Set<string>; questions: Set<string> } {
  const ids = new Set<string>()
  const questions = new Set<string>()
  let from = 0
  for (;;) {
    const start = promptText.indexOf(REPLY_OPEN, from)
    const end = start === -1 ? -1 : promptText.indexOf(REPLY_CLOSE, start)
    if (end === -1) {
      return { ids, questions }
    }
    from = end + REPLY_CLOSE.length
    let replies: unknown = null
    try {
      replies = JSON.parse(promptText.slice(start + REPLY_OPEN.length, end))
    } catch {
      continue // Why: a malformed block answers nothing specific.
    }
    for (const reply of Array.isArray(replies) ? replies : []) {
      const record = reply as { questionItemId?: unknown; question?: unknown } | null
      if (typeof record?.question === 'string') {
        // Why the same cut: the open question keeps only its first MAX_QUESTION characters.
        questions.add(quotedQuestionLine(record.question.slice(0, MAX_QUESTION)))
      }
      try {
        const parsed =
          typeof record?.questionItemId === 'string'
            ? (JSON.parse(record.questionItemId) as unknown)
            : null
        if (Array.isArray(parsed) && parsed[0] === CODEX_ASYNC_QUESTION_TOOL) {
          ids.add(JSON.stringify([parsed[1], parsed[2]]))
        }
      } catch {
        // Why per reply: one bad id must not hide the other answers in the block.
      }
    }
  }
}

/** A question as its answer quotes it (`> question`); formatAsyncAskAnswer writes the same. */
export function quotedQuestionLine(question: string): string {
  return question.replace(/[\r\n]+/g, ' ').trim()
}

export function keepQuestions(ask: CodexAsyncAsk, keep: boolean[]): CodexAsyncAsk | null {
  const questions = ask.envelope.asyncQuestions.filter((_, i) => keep[i])
  return questions.length > 0
    ? {
        envelope: { delivery: 'async', asyncQuestions: questions },
        sources: ask.sources.filter((_, i) => keep[i])
      }
    : null
}

/** Whether Codex accepted the call (`{"accepted":true}`). Its hook's tool_response is the
 *  serialized output body (a string or content parts), so match the pair wherever it sits. */
export function codexAsyncCallAccepted(response: unknown): boolean {
  let serialized: string
  try {
    serialized = JSON.stringify(response) ?? ''
  } catch {
    return false
  }
  return /accepted\\*"\s*:\s*true/.test(serialized)
}

/** Quoted question lines (`> question`), the layout OmniConsole and Codex answer in. */
function quotedQuestions(promptText: string): Set<string> {
  const quoted = new Set<string>()
  for (const line of promptText.split(/\r?\n/)) {
    const match = /^>\s?(.*)$/.exec(line)
    if (match) {
      quoted.add(match[1]!.trim())
    }
  }
  return quoted
}

/** The questions (as their answers quote them) a message answers in the reply layout. */
export function questionsQuotedByMessage(questions: readonly string[], message: string): string[] {
  const quoted = quotedQuestions(message)
  return questions.map(quotedQuestionLine).filter((line) => quoted.has(line))
}

/** Which open questions one user message answers, by reply block or quoted question. */
function answeredQuestions(ask: CodexAsyncAsk, promptText: string): boolean[] {
  const replies = repliedTo(promptText)
  const quoted = quotedQuestions(promptText)
  return ask.envelope.asyncQuestions.map((question, i) => {
    const line = quotedQuestionLine(question.question)
    return (
      replies.ids.has(JSON.stringify([ask.sources[i]!.toolUseId, ask.sources[i]!.index])) ||
      replies.questions.has(line) ||
      quoted.has(line)
    )
  })
}

function questionsResolvedByMessage(ask: CodexAsyncAsk, promptText: string): boolean[] {
  const answered = answeredQuestions(ask, promptText)
  // An unmatched explicit reply block answers nothing; an ordinary prompt clears Codex's asks.
  return answered.some(Boolean) || promptText.includes(REPLY_OPEN)
    ? answered
    : ask.sources.map(() => true)
}

/**
 * The ask left after a user message: a reply block or a quoted answer removes only the questions
 * it names; any other message clears them all. Why a message steering the running turn too:
 * Codex clears its own open questions on every ordinary prompt (codex-rs 0.160
 * `tui/src/chatwidget/input_submission.rs`), and the agent reads that message as the reply, so
 * keeping them asked the person again once the turn ended.
 */
export function remainingCodexAsyncAsk(
  ask: CodexAsyncAsk,
  promptText: string
): CodexAsyncAsk | null {
  return keepQuestions(
    ask,
    questionsResolvedByMessage(ask, promptText).map((done) => !done)
  )
}

/** The earliest point of `path` any open question was asked at; null when none was marked there. */
export function codexAsyncAskTranscriptStart(ask: CodexAsyncAsk, path: string): number | null {
  const offsets = ask.sources
    .map((source) => (source.asked?.path === path ? source.asked.offset : null))
    .filter((offset): offset is number => offset !== null)
  return offsets.length > 0 ? Math.min(...offsets) : null
}

/**
 * The ask left after the user messages Codex wrote to its transcript. Why only messages written
 * after each question was asked: an earlier answer to the same words (the one that started this
 * turn, or a generic question asked again) answered an earlier question, not this one.
 */
export function remainingAfterCodexTranscript(
  ask: CodexAsyncAsk,
  path: string,
  messages: readonly { text: string; offset: number }[]
): CodexAsyncAsk | null {
  const answered = ask.sources.map(() => false)
  for (const message of messages) {
    questionsResolvedByMessage(ask, message.text).forEach((hit, i) => {
      const asked = ask.sources[i]!.asked
      if (hit && asked?.path === path && message.offset >= asked.offset) {
        answered[i] = true
      }
    })
  }
  return keepQuestions(
    ask,
    answered.map((done) => !done)
  )
}

/** Drops the questions of a tool call Codex rejected or failed: it never showed them. */
export function withoutCodexAsyncCall(
  ask: CodexAsyncAsk,
  toolUseId: string | undefined
): CodexAsyncAsk | null {
  return keepQuestions(
    ask,
    ask.sources.map((source) => !toolUseId || source.toolUseId !== toolUseId)
  )
}
