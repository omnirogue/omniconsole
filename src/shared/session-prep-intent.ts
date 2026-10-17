export const SESSION_PREP_TOKEN = '(sessions)'

const QUESTION_FIRST =
  /^(should|would|shall|do|does|did|is|are|was|were|why|how|what|when|where|which|who)\b/i
const POLITE = /^(please[, ]+|can you\s+|could you\s+|go ahead and\s+)/i
// Why: people open with filler ("ok", "ok let's try it,") before the ask. Only words that carry no
// instruction are skipped, so "fix this and create sessions for …" still goes to the agent.
const LEAD_IN_WORDS = new Set(
  "ok okay k yes yeah yep yup sure cool great nice perfect awesome good alright right so now then next also and well hey thanks let's lets let us try it again just".split(
    ' '
  )
)
const MAX_LEAD_IN_WORDS = 8
const LEAD_IN_WORD = /^([A-Za-z]+(?:['\u2019][A-Za-z]+)?)(?:[\s,.;:!\u2014\u2013-]+)/
const VERBS = [
  'spin up',
  'kick off',
  'fire up',
  'set up',
  'create',
  'start',
  'launch',
  'open',
  'prepare',
  'prep',
  'make'
] as const
const NEW_TARGET = /^(?:agents?|conversations?)$/
const WORD = /[A-Za-z0-9_#']+/g
const PURPOSE_WORD = /^(for|to|that|which|who|where|with|about|on)\b/i
const MAX_INTERVENING_WORDS = 4

function wordCount(text: string): number {
  return text.match(/[A-Za-z0-9_#]+/g)?.length ?? 0
}

function stripLeadIn(text: string): string {
  let rest = text
  for (let words = 0; words < MAX_LEAD_IN_WORDS; words += 1) {
    const match = LEAD_IN_WORD.exec(rest)
    if (!match || !LEAD_IN_WORDS.has(match[1]!.toLowerCase().replace('\u2019', "'"))) {
      return rest
    }
    rest = rest.slice(match[0].length)
  }
  return rest
}

function stripPolitePrefix(text: string): string {
  let rest = text
  for (;;) {
    const next = stripLeadIn(rest).replace(POLITE, '')
    if (next === rest) {
      return rest
    }
    rest = next
  }
}

/** One edit (insert, delete, substitute, swap neighbours) apart. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) {
    return false
  }
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1
  }
  if (a.length === b.length) {
    return (
      a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
    )
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

// Why: "sesssion", "sesion" and "sessoin" are the same ask; "lesson" and "season" are not.
function isSessionWord(word: string): boolean {
  return (
    word.startsWith('se') && (withinOneEdit(word, 'session') || withinOneEdit(word, 'sessions'))
  )
}

function matchVerb(text: string): string | null {
  const lower = text.toLowerCase()
  for (const verb of VERBS) {
    if (!lower.startsWith(verb)) {
      continue
    }
    const next = text[verb.length]
    if (next !== undefined && /[A-Za-z]/i.test(next)) {
      continue
    }
    return text.slice(verb.length)
  }
  return null
}

function firstTarget(rest: string): { end: number } | null {
  WORD.lastIndex = 0
  let before = 0
  let previous = ''
  for (let match = WORD.exec(rest); match; match = WORD.exec(rest)) {
    const word = match[0].toLowerCase()
    const end = match.index + match[0].length
    if (isSessionWord(word) && before <= MAX_INTERVENING_WORDS) {
      return { end }
    }
    if (previous === 'new' && NEW_TARGET.test(word) && before - 1 <= MAX_INTERVENING_WORDS) {
      return { end }
    }
    if (before > MAX_INTERVENING_WORDS) {
      return null
    }
    previous = word
    before += 1
  }
  return null
}

function purposeContent(afterTarget: string): string | null {
  const start = afterTarget.replace(/^[ \t]+/, '')
  const word = PURPOSE_WORD.exec(start)
  if (word) {
    return start.slice(word[0].length)
  }
  if (/^[:—,]/.test(start)) {
    return start.slice(1)
  }
  if (start.startsWith('-')) {
    return start.slice(1)
  }
  const newline = /^\r?\n/.exec(start)
  return newline ? start.slice(newline[0].length) : null
}

function stripToken(text: string): string {
  return text.replaceAll(SESSION_PREP_TOKEN, ' ').replace(/\s+/g, ' ').trim()
}

/** True only for an explicit ask to create new sessions, never a question or mention. */
// Why: text copied from a rendered reply keeps its quote bar or bullet ("▎ launch sessions …").
// A markdown "> …" is not stripped: that is someone quoting an ask, not making it.
const LEADING_DECORATION =
  /^[\s*\u2022\u00b7\u2023\u25aa\u25b8\u2192\u203a\u276f\u2502\u2503\u258e\u258d\u258c\u258f-]+/

export function detectSessionPrepRequest(text: string): { request: string } | null {
  const trimmed = text.replace(LEADING_DECORATION, '').trim()
  if (!trimmed || trimmed.startsWith('/')) {
    return null
  }
  if (trimmed.includes(SESSION_PREP_TOKEN)) {
    return { request: stripToken(trimmed) }
  }
  const ask = stripPolitePrefix(trimmed)
  if (QUESTION_FIRST.test(trimmed) || QUESTION_FIRST.test(ask)) {
    return null
  }
  const afterVerb = matchVerb(ask)
  if (afterVerb === null) {
    return null
  }
  const target = firstTarget(afterVerb)
  if (!target) {
    return null
  }
  const content = purposeContent(afterVerb.slice(target.end))
  if (content === null || wordCount(content) < 2) {
    return null
  }
  return { request: trimmed }
}
