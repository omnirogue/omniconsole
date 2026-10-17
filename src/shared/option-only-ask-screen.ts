import type { AskPrompt } from './native-chat-ask-types'

export type OptionOnlyAskScreenAgent = 'gemini' | 'qwen' | 'hermes'

/** The agents whose one-click answers are typed only onto their own verified dialog. */
export function optionOnlyAskScreenAgent(
  agent: string | null | undefined
): OptionOnlyAskScreenAgent | null {
  return agent === 'gemini' || agent === 'hermes' ? agent : agent === 'qwen-code' ? 'qwen' : null
}

/** Which step of this prompt the agent's dialog shows: a question index, or its Submit/Review tab. */
export type OptionOnlyAskScreenStep = number | 'submit'

type DialogChrome = {
  /** The dialog's own title line; the LAST one on screen is the live dialog. */
  isHeader: (line: string) => boolean
  footers: readonly string[]
  /** Anything after the header that means another prompt or a closed dialog owns the screen. */
  foreign: readonly RegExp[]
  /** The highlighted free-text row: a digit there becomes typed text, not a pick. */
  freeTextHighlighted: (line: string, prompt: AskPrompt) => boolean
  /** The question text as the dialog draws it (Gemini renders it as inline markdown). */
  shownText?: (question: string) => string
  /** The batch's final Submit/Review step for this prompt (its own footer may differ). */
  isSubmitStep?: (dialog: DialogLines, prompt: AskPrompt) => boolean
  /** The dialog's own marker agrees that question `step` of a batch is the active one. */
  confirmsStep?: (dialog: DialogLines, prompt: AskPrompt, step: number) => boolean
}

/** Dialog lines squashed for text matching, and `raw` with inner spacing kept (tab rows). */
type DialogLines = { text: readonly string[]; raw: readonly string[] }

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Gemini's InlineMarkdownRenderer output as plain text: `code` loses its backticks, [text](url)
 * shows as "text (url)", and **bold**, __bold__, *italic*, _italic_ and ~~strike~~ lose markers.
 */
function geminiInlineText(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '$1$2')
}

const headersOf = (prompt: AskPrompt): string[] | null =>
  prompt.questions.every((q) => Boolean(q.header?.trim()))
    ? prompt.questions.map((q) => squash(q.header!))
    : null

// Why tokens: a header can be a prefix of another ("DB" / "DB host"), so match whole tab labels.
function tabLabels(raw: string): string[] {
  return raw
    .split(/\s{2,}|[│←→□✓≡▸]/)
    .map(squash)
    .filter((label) => label.length > 0)
}

// The label right after a tab row's "▸" (Qwen's active tab).
function activeTabLabel(raw: string): string | null {
  const after = raw.split('▸')[1]
  return after === undefined ? null : squash(after.split(/\s{2,}|✓/)[0] ?? '')
}

// Markers from live captures (Gemini CLI 0.61.0, Qwen Code 0.22.3, Hermes 0.21.5; 27 Sep 2026).
const CHROME: Record<OptionOnlyAskScreenAgent, DialogChrome> = {
  gemini: {
    isHeader: (line) => line === 'Answer Questions',
    footers: ['Esc to cancel', 'Enter to submit'],
    foreign: [/Request cancelled/, /Type your message/, /User answered:/],
    // Why placeholders: a question's own placeholder replaces "Enter a custom value".
    freeTextHighlighted: (line, prompt) => {
      const row = line.match(/^● \d+\. (.+)$/)?.[1]
      return (
        row !== undefined &&
        (row === 'Enter a custom value' ||
          prompt.questions.some(
            (q) => q.placeholder !== undefined && row === squash(geminiInlineText(q.placeholder))
          ))
      )
    },
    shownText: (question) => geminiInlineText(question),
    isSubmitStep: ({ text }) =>
      text.includes('Review your answers:') &&
      text.some((line) => line.startsWith('Enter to submit') && line.includes('Esc to cancel')),
    // Why only the tab bar: Gemini marks the active tab by color alone, so require this prompt's tabs.
    confirmsStep: ({ raw }, prompt) => {
      const headers = headersOf(prompt)
      return (
        headers !== null &&
        raw.some((line) => {
          const labels = tabLabels(line)
          return labels.includes('Review') && headers.every((header) => labels.includes(header))
        })
      )
    }
  },
  qwen: {
    isHeader: (line) => /^\? AskUserQuestion Ask user \d+ questions?\b/.test(line),
    footers: ['Esc: Cancel'],
    // Why: another tool's confirmation (e.g. "Allow execution of:") owns the digits, not this question.
    foreign: [
      /^\? (?!AskUserQuestion )\S/,
      /Allow execution of/,
      /allow once/i,
      /Type your message/
    ],
    freeTextHighlighted: (line) => /^❯ \d+\. Type something/.test(line),
    // Why its own shape: the Submit tab's footer has no "Esc: Cancel", and digit 1 is Submit.
    isSubmitStep: ({ text, raw }, prompt) => {
      const headers = headersOf(prompt)
      return (
        headers !== null &&
        raw.some(
          (line) =>
            activeTabLabel(line) === 'Submit' && headers.every((h) => tabLabels(line).includes(h))
        ) &&
        text.includes('Ready to submit your answers?') &&
        text.includes('❯ 1. Submit answers') &&
        text.includes('2. Cancel') &&
        text.some((line) => line.startsWith('↑/↓: Navigate') && line.endsWith('Enter: Select'))
      )
    },
    // The tab row marks the active tab "▸ <header>".
    confirmsStep: ({ raw }, prompt, step) => {
      const headers = headersOf(prompt)
      if (!headers || new Set(headers).size !== headers.length) {
        return false
      }
      return raw.some((line) => {
        const labels = tabLabels(line)
        return (
          labels.at(-1) === 'Submit' &&
          headers.every((h) => labels.includes(h)) &&
          activeTabLabel(line) === headers[step]
        )
      })
    }
  },
  hermes: {
    isHeader: (line) => /^ask \d+ questions?$/.test(line),
    footers: ['Esc/Ctrl+C cancel'],
    foreign: [/^\(cancelled\)$/],
    freeTextHighlighted: (line) => /^▸ \d+\. Other \(type your answer\)/.test(line)
  }
}

// Why strip box edges: Gemini draws the dialog inside │ … │; Hermes and Qwen pad a │/┃/█ scroll gutter.
function screenLines(screen: string): string[] {
  return screen.split('\n').map((line) => line.replace(/^\s*[│┃]|[│┃█]\s*$/g, '').trim())
}

// Why whole text: questions can share an opening ("Which database …?") or be a prefix of another.
// Why rejoin: a long question wraps at the pane width onto following lines.
function questionsStartingAt(
  lines: readonly string[],
  start: number,
  first: string,
  questions: readonly string[]
): number[] {
  const matches: number[] = []
  questions.forEach((question, index) => {
    let block = first
    for (let next = start + 1; block.length < question.length && next < lines.length; next += 1) {
      block = squash(`${block} ${lines[next]}`)
    }
    if (question.length > 0 && block === question) {
      matches.push(index)
    }
  })
  return matches
}

/** The one question whose full text is shown at some line, or null when none or several match. */
function shownQuestion(
  lines: readonly string[],
  questions: readonly string[],
  lineText: (line: string) => string | null = (line) => line
): number | null {
  const found = new Set<number>()
  lines.forEach((line, index) => {
    const text = lineText(line)
    if (text !== null) {
      questionsStartingAt(lines, index, text, questions).forEach((q) => found.add(q))
    }
  })
  return found.size === 1 ? [...found][0]! : null
}

// Hermes lists every question: "✓ <answered>", "▸ <active>", "· <waiting>", and "k/n answered".
function hermesStep(body: readonly string[], questions: readonly string[]): number | null {
  const marked = (marker: string) => (line: string) =>
    line.startsWith(`${marker} `) && !/^\S \d+\./.test(line) ? line.slice(2) : null
  const active = shownQuestion(body, questions, marked('▸'))
  if (active === null) {
    return null
  }
  const answered = body.flatMap((line, index) => {
    const text = marked('✓')(line)
    return text === null ? [] : questionsStartingAt(body, index, text, questions)
  })
  const expected = questions.slice(0, active).map((_, index) => index)
  const count = body.map((line) => line.match(/^(\d+)\/\d+ answered/)?.[1]).find(Boolean)
  const sameAnswered =
    answered.length === expected.length && expected.every((index) => answered.includes(index))
  return sameAnswered && (count === undefined || Number(count) === active) ? active : null
}

/**
 * The step of THIS prompt the agent's own dialog shows now, or null when the screen does not show
 * it: unreadable, cancelled, answered, covered by another confirmation, ambiguous, or with the
 * highlight on the free-text row. Keys go only on a match.
 */
export function readOptionOnlyAskScreen(
  agent: OptionOnlyAskScreenAgent,
  screen: string | null | undefined,
  prompt: AskPrompt
): OptionOnlyAskScreenStep | null {
  if (!screen) {
    return null
  }
  const chrome = CHROME[agent]
  const rawLines = screenLines(screen)
  let headerAt = -1
  rawLines.forEach((line, index) => {
    if (chrome.isHeader(squash(line))) {
      headerAt = index
    }
  })
  if (headerAt === -1) {
    return null
  }
  const raw = rawLines.slice(headerAt + 1).filter((line) => line.length > 0)
  const dialog = raw.map(squash)
  const lines: DialogLines = { text: dialog, raw }
  if (
    dialog.some(
      (line) =>
        chrome.foreign.some((re) => re.test(line)) || chrome.freeTextHighlighted(line, prompt)
    )
  ) {
    return null
  }
  const batch = prompt.questions.length > 1
  // Why first: a Review/Submit step may list the questions it summarizes.
  if (batch && chrome.isSubmitStep?.(lines, prompt)) {
    return 'submit'
  }
  const footerAt = dialog.findIndex((line) => chrome.footers.some((f) => line.includes(f)))
  if (footerAt === -1) {
    return null
  }
  const body = dialog.slice(0, footerAt + 1)
  const questions = prompt.questions.map((question) =>
    squash(chrome.shownText ? chrome.shownText(question.question) : question.question)
  )
  if (new Set(questions).size !== questions.length) {
    return null
  }
  const step = agent === 'hermes' ? hermesStep(body, questions) : shownQuestion(body, questions)
  if (step === null) {
    return null
  }
  return !batch || !chrome.confirmsStep || chrome.confirmsStep(lines, prompt, step) ? step : null
}
