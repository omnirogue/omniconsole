import type { SessionFollowUpAction } from './session-follow-up-rule'

/**
 * Reads "once done, send the final deliverables to Iris for review by Friday 5pm"
 * into the same fields the Next step controls fill. Pure and conservative: it only
 * reports what the text says; names are resolved against the roster separately.
 */
export type FollowUpDeliverableIntent = { kind: 'final' } | { kind: 'files'; names: string[] }

export type FollowUpIntent = {
  whenFinished: boolean
  action: SessionFollowUpAction | null
  recipientNames: string[]
  deliverables: FollowUpDeliverableIntent | null
  includeSummary: boolean
  due: { at: string; phrase: string } | null
}

const ACTION_PATTERNS: readonly (readonly [SessionFollowUpAction, RegExp])[] = [
  ['approve', /\b(?:approv(?:e|al|es|ing)|sign[- ]?off)\b/i],
  ['decide', /\b(?:decide|decision)\b/i],
  ['edit', /\b(?:edit|edits|editing|revise)\b/i],
  ['review', /\b(?:review|reviews|reviewing|feedback|check it|look over)\b/i],
  ['fyi', /\b(?:fyi|for (?:their |his |her |your )?(?:information|reference|awareness))\b/i]
]
const WHEN_FINISHED =
  /\b(?:once|when|after|as soon as)\b[^.!?]*?\b(?:done|finish(?:ed|es)?|complete[sd]?|over|ready|through)\b/i
const FINAL_DELIVERABLES =
  /\b(?:deliverables?|outputs?|final (?:files?|version|results?|artifacts?)|the (?:files|results|artifacts))\b/i
const SUMMARY = /\b(?:summary|summari[sz]e|recap)\b/i
const FILE_NAME =
  /(?:^|[\s"'`(])((?:[\w.-]+[\\/])*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s"'`),;:!?]|\.(?:\s|$))/g
const NOT_FILES = new Set(['e.g', 'i.e'])
const WEB_SUFFIXES = new Set(['com', 'org', 'net', 'io', 'ai', 'co', 'dev', 'app'])
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const TIME = '\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|\\d{1,2}:\\d{2}|noon|eod|end of (?:the )?day'
const DAY = `(?:next |this )?(?:today|tonight|tomorrow|eod|end of (?:the )?day|cob|close of business|noon|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|\\d{4}-\\d{2}-\\d{2}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}|${TIME})`
const DUE_CLAUSE = new RegExp(
  `\\b(?:by|due|before|no later than)\\s+(${DAY}(?:\\s*(?:,|at)?\\s*(?:${TIME}))?)`,
  'i'
)
const NAME_STOP =
  /\s+(?:for|by|due|before|with|so|once|when|after|as soon as|fyi|to\s+(?:review|approve|decide|edit|check|look|sign))\b|\s+and\s+(?:ask|tell|have|include|attach|add)\b|[.;!?]|$/i
const DATIVE_STOP =
  /\s+(?:the|my|our|a|an|all|his|her|their|final|these|those|this|it)\b|[.;!?,]|$/i
const NOT_NAMES = new Set([
  'me',
  'him',
  'her',
  'them',
  'us',
  'team',
  'everyone',
  'review',
  'approve',
  'approval',
  'decide',
  'edit',
  'the',
  'it'
])
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DEFAULT_DUE_HOUR = 17

function parseTime(text: string): { hours: number; minutes: number } | null {
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text)
  if (ampm) {
    const hour = Number(ampm[1])
    const minutes = Number(ampm[2] ?? 0)
    if (hour < 1 || hour > 12 || minutes > 59) {
      return null
    }
    return { hours: (hour % 12) + (ampm[3] === 'pm' ? 12 : 0), minutes }
  }
  const clock = /\b(\d{1,2}):(\d{2})\b/.exec(text)
  if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) {
    return { hours: Number(clock[1]), minutes: Number(clock[2]) }
  }
  if (/\bnoon\b/.test(text)) {
    return { hours: 12, minutes: 0 }
  }
  if (/\b(?:eod|end of (?:the )?day|cob|close of business)\b/.test(text)) {
    return { hours: DEFAULT_DUE_HOUR, minutes: 0 }
  }
  return null
}

function startOfDay(now: Date, addDays = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDays)
}

function monthIndex(value: string): number {
  return MONTHS.indexOf(value.slice(0, 3).toLowerCase())
}

/** A due phrase in local time: "Friday 5pm", "tomorrow", "Sep 15", "2026-09-15 14:00". */
export function parseDuePhrase(phrase: string, now: Date): Date | null {
  const text = phrase.toLowerCase()
  const time = parseTime(text)
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text)
  const monthFirst = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})`).exec(text)
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}`).exec(text)
  const weekday = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(text)
  let date: Date | null = null
  let rolls: 'week' | 'day' | null = null
  if (iso) {
    date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  } else if (monthFirst || dayFirst) {
    const month = monthIndex(monthFirst ? monthFirst[1]! : dayFirst![2]!)
    const day = Number(monthFirst ? monthFirst[2] : dayFirst![1])
    date = new Date(now.getFullYear(), month, day)
    if (date < startOfDay(now)) {
      date.setFullYear(date.getFullYear() + 1)
    }
  } else if (/\btomorrow\b/.test(text)) {
    date = startOfDay(now, 1)
  } else if (/\b(?:today|tonight|eod|end of (?:the )?day|cob|close of business)\b/.test(text)) {
    date = startOfDay(now)
  } else if (weekday) {
    date = startOfDay(now, (WEEKDAYS.indexOf(weekday[1]!) - now.getDay() + 7) % 7)
    rolls = 'week'
  } else if (time) {
    date = startOfDay(now)
    rolls = 'day'
  }
  if (!date || Number.isNaN(date.getTime())) {
    return null
  }
  const hours = time?.hours ?? (/\btonight\b/.test(text) ? 20 : DEFAULT_DUE_HOUR)
  date.setHours(hours, time?.minutes ?? 0, 0, 0)
  if (date <= now && rolls) {
    date.setDate(date.getDate() + (rolls === 'week' ? 7 : 1))
  }
  return date
}

function fileNames(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(FILE_NAME)) {
    const name = match[1]!
    const suffix = name.split('.').pop()!.toLowerCase()
    if (!NOT_FILES.has(name.toLowerCase()) && !WEB_SUFFIXES.has(suffix) && !names.includes(name)) {
      names.push(name)
    }
  }
  return names
}

function segmentAfter(text: string, anchor: RegExp, stop: RegExp): string | null {
  const found = anchor.exec(text)
  if (!found) {
    return null
  }
  const rest = text.slice(found.index + found[0].length)
  const end = stop.exec(rest)
  return rest.slice(0, end ? end.index : rest.length).trim() || null
}

function splitNames(segment: string | null): string[] {
  if (!segment) {
    return []
  }
  return segment
    .split(/\s*(?:,|&|\+|\band\b)\s*/i)
    .map((name) =>
      name
        .trim()
        .replace(/^@/, '')
        .replace(/[’']s$/i, '')
    )
    .filter((name) => name.length > 0 && !NOT_NAMES.has(name.toLowerCase()))
}

function recipientNames(text: string): string[] {
  const anchors: readonly (readonly [RegExp, RegExp])[] = [
    [
      /\b(?:send|forward|hand(?:\s+(?:it|them))?(?:\s+off)?|give|share|pass|deliver|route)\b.*?\bto\s+/i,
      NAME_STOP
    ],
    [/\bask\s+/i, /\s+to\b|[.;!?]|$/i],
    // Why: no `i` flag here; with it \p{Lu} would also accept lowercase words like "review".
    [/\b[Ff]or\s+(?=[@\p{Lu}])/u, /\s+to\b|[.;!?]|$/i],
    [/\b(?:[Ss]end|[Gg]ive|[Ff]orward)\s+(?=[@\p{Lu}])/u, DATIVE_STOP]
  ]
  for (const [anchor, stop] of anchors) {
    const names = splitNames(segmentAfter(text, anchor, stop))
    if (names.length > 0) {
      return names
    }
  }
  return []
}

export function parseFollowUpRequest(input: string, now: Date): FollowUpIntent {
  const text = input.replace(/\s+/g, ' ').trim()
  const dueMatch = DUE_CLAUSE.exec(text)
  const dueDate = dueMatch ? parseDuePhrase(dueMatch[1]!, now) : null
  const files = fileNames(text)
  // Why: dates and file names must not be read as people.
  let remainder = dueMatch ? text.replace(dueMatch[0], ' ') : text
  for (const name of files) {
    remainder = remainder.replace(name, ' ')
  }
  remainder = remainder.replace(/\s+/g, ' ')
  const action = ACTION_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null
  return {
    whenFinished: WHEN_FINISHED.test(text),
    action,
    recipientNames: recipientNames(remainder),
    deliverables:
      files.length > 0
        ? { kind: 'files', names: files }
        : FINAL_DELIVERABLES.test(text)
          ? { kind: 'final' }
          : null,
    includeSummary: SUMMARY.test(text),
    due: dueMatch && dueDate ? { at: dueDate.toISOString(), phrase: dueMatch[1]!.trim() } : null
  }
}
