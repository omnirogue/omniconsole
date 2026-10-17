import { resolveRosterName, type TeamRosterPerson } from './team-roster-search'
import {
  SESSION_OUTCOME_WAIT_BRIEF_MARKER,
  type SessionOutcomeEventSource
} from './session-outcome-event'

/**
 * The waits a person asked for in their own words: "wait for Uma and Iris to approve on Slack",
 * "when Iris signs in to omnios", "wait for a reply from uma@…", "wait 10 minutes", "wait for
 * https://github.com/…/pull/12 to merge", "wait for the billing session to finish", "if no answer by
 * Friday, ask me". The host parses these so an agent can only file a wait the person actually asked
 * for; the agent still writes the plan.
 */
export type NextOutcomeWaitRequest = {
  /** The exact words of the clause, as typed. */
  instruction: string
  kind: 'person' | 'signin' | 'github' | 'session' | 'time' | 'deadline'
  /** Names (or addresses) as typed; empty for time and GitHub waits. */
  people: string[]
  /** Where the answer comes from; absent for a person wait that named no channel. */
  source?: SessionOutcomeEventSource
  match?: 'approve' | 'reply' | 'signin' | 'review' | 'merged' | 'at' | 'result'
  /** The Jira key, the sign-in app or the pull request URL, when the words carry one. */
  ref?: string
}

export type ResolvedNextOutcomeWait = NextOutcomeWaitRequest & {
  persons: TeamRosterPerson[]
  unresolved: string[]
}

const SCAN_LIMIT = 32_000
const NAME = "[\\p{L}][\\p{L}\\p{N}.'’@_+-]*(?: [\\p{Lu}][\\p{L}'’-]*)?"
const PEOPLE = `${NAME}(?:\\s*(?:,|\\band\\b|&)\\s*(?:both\\s+)?${NAME})*`
const APPROVE = /\b(?:approv\w*|ok(?:ay|'?s)?|confirm\w*|sign(?:s|ed)? off|go[- ]ahead|lgtm)\b/i
const REPLY = /\b(?:repl\w*|respon\w*|answer\w*|messag\w*|hear back|get back)\b/i

const NOT_ARTICLE = '(?!(?:an?|the|their|his|her|my|your)\\s)'
const PERSON_WAIT = new RegExp(
  `\\b(?:wait(?:ing)? (?:for|on|until)|once|after|when)\\s+(?:both\\s+)?${NOT_ARTICLE}(${PEOPLE})\\s+(?:(?:both|all|each)\\s+)?(?:(?:has|have|to)\\s+)?(?:approv\\w*|ok(?:ay)?s?|confirm\\w*|sign(?:s|ed)? off|repl\\w*|respon\\w*|answer\\w*|messag\\w*)\\b`,
  'iu'
)
const REPLY_FROM = new RegExp(
  `\\bwait(?:ing)? for (?:an? |the |their |his |her )?(?:approv\\w*|ok|okay|confirmation|go-ahead|repl\\w*|respon\\w*|answer)\\s+(?:from|by)\\s+(${PEOPLE})`,
  'iu'
)
const SIGNIN = new RegExp(
  `\\b(?:wait(?:ing)? (?:for|until)|once|after|when)\\s+(${PEOPLE})\\s+(?:signs?|logs?|has signed|has logged) (?:in|on)(?:\\s+(?:to|at|into|on)\\s+([\\w.-]+))?`,
  'iu'
)
const GITHUB_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/
const GITHUB_WAIT =
  /\b(?:wait(?:ing)? (?:for|until|on)|once|after|when)\b[^.;!?\n]*?https:\/\/github\.com\/[^\s]+\/pull\/\d+[^.;!?\n]*?\b(merge\w*|approv\w*|review\w*)/i
// Another session's result: "wait for the billing session to finish", "once session tab-2:… is done".
const SESSION_WAIT =
  /\b(?:wait(?:ing)? (?:for|on|until)|once|after|when)\b[^.;!?\n]*?\bsession\b[^.;!?\n]*?\b(?:finish\w*|done|complete\w*|result\w*|ends?|ended|wraps? up)\b/i
const TIME_WAIT =
  /\bwait(?:ing)?(?:\s+for)?\s+(?:(?:\d+|an?|one|two|three|five|ten|fifteen|twenty|thirty)\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b|(?:until|till)\s+[^,.;!?\n]+)/i
const DEADLINE =
  /\bif (?:there(?:'s| is) )?(?:no (?:answer|reply|response|approval|word)|(?:they|he|she|nobody|no one|[\p{Lu}][\p{L}'’-]*) (?:do(?:es)?n['’]?t|did(?:n['’]t| not)|ha(?:s|ve)n['’]?t|(?:has|have) not) (?:answer|reply|respond|approve|sign)\w*)[^,.;!?\n]*?\b(?:by|before|within)\s+[^,.;!?\n]+/iu
const JIRA_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,9}\b/
/** What people call an app, mapped to the sign-in key omnios lists for it. */
const APP_ALIASES: Record<string, string> = {
  omnios: 'omniconsole',
  'omni-os': 'omniconsole',
  console: 'omniconsole',
  omniconsole: 'omniconsole'
}

export function signinAppKey(typed: string): string {
  const key = typed.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  return APP_ALIASES[key] ?? key
}
const NOT_A_PERSON = /^(?:both|all|each|them|they|everyone|the|a|an|and|it|this|that|me|us)$/i

function channel(clause: string, people: string[]): SessionOutcomeEventSource | undefined {
  if (/\bslack\b/i.test(clause)) {
    return 'slack'
  }
  if (/\bjira\b/i.test(clause) || JIRA_KEY.test(clause)) {
    return 'jira'
  }
  if (/\be-?mail\b/i.test(clause) || people.some((person) => person.includes('@'))) {
    return 'email'
  }
  return undefined
}

function splitPeople(value: string): string[] {
  return value
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((name) =>
      name
        .replace(/^both\s+/i, '')
        .replace(/\s+(?:to|has|have|had|both|all|each)$/i, '')
        .replace(/['’]s$/, '')
        .trim()
    )
    .filter((name) => name && !NOT_A_PERSON.test(name))
}

function clauses(prompt: string): string[] {
  const visible = prompt
    .slice(0, SCAN_LIMIT)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
  return visible
    .split(/\n+|(?<=[.!?;])\s+|,\s*(?:and\s+)?then\s+|\s+then\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** Every wait the prompt asks for, clause by clause; a quoted or fenced mention asks for nothing. */
export function nextOutcomeWaitRequests(prompt: string): NextOutcomeWaitRequest[] {
  const requests: NextOutcomeWaitRequest[] = []
  if (prompt.trimStart().startsWith(SESSION_OUTCOME_WAIT_BRIEF_MARKER)) {
    return requests
  }
  for (const clause of clauses(prompt)) {
    if (/^\s*["“]/.test(clause) || /\b(?:don['’]t|do not|never|without) wait/i.test(clause)) {
      continue
    }
    const deadline = DEADLINE.exec(clause)
    if (deadline) {
      requests.push({ instruction: deadline[0], kind: 'deadline', people: [], match: 'at' })
      continue
    }
    const github = GITHUB_WAIT.exec(clause)
    if (github) {
      requests.push({
        instruction: github[0],
        kind: 'github',
        people: [],
        source: 'github',
        match: /^merge/i.test(github[1]!) ? 'merged' : 'review',
        ref: GITHUB_URL.exec(github[0])![0]
      })
      continue
    }
    // Before time and person waits: "wait until the billing session finishes" is neither.
    const session = SESSION_WAIT.exec(clause)
    if (session) {
      requests.push({
        instruction: session[0],
        kind: 'session',
        people: [],
        source: 'session',
        match: 'result'
      })
      continue
    }
    const signin = SIGNIN.exec(clause)
    if (signin) {
      requests.push({
        instruction: signin[0],
        kind: 'signin',
        people: splitPeople(signin[1]!),
        source: 'signin',
        match: 'signin',
        ...(signin[2] ? { ref: signinAppKey(signin[2]) } : {})
      })
      continue
    }
    const person = PERSON_WAIT.exec(clause) ?? REPLY_FROM.exec(clause)
    if (person) {
      const people = splitPeople(person[1]!)
      const rest = clause.slice(person.index)
      const source = channel(rest, people)
      const key = source === 'jira' ? JIRA_KEY.exec(rest)?.[0] : undefined
      requests.push({
        instruction: rest.replace(/[,;.!?]\s*$/, '').trim(),
        kind: 'person',
        people,
        ...(source ? { source } : {}),
        match: APPROVE.test(person[0]) || !REPLY.test(person[0]) ? 'approve' : 'reply',
        ...(key ? { ref: key } : {})
      })
      continue
    }
    const time = TIME_WAIT.exec(clause)
    if (time) {
      requests.push({ instruction: time[0], kind: 'time', people: [], source: 'time', match: 'at' })
    }
  }
  return requests
}

/** Resolve typed names against the signed-in roster; an address resolves by its first name. */
export function resolveNextOutcomeWaits(
  prompt: string,
  roster: readonly TeamRosterPerson[]
): ResolvedNextOutcomeWait[] {
  return nextOutcomeWaitRequests(prompt).map((request) => {
    const persons: TeamRosterPerson[] = []
    const unresolved: string[] = []
    for (const typed of request.people) {
      const query = typed.includes('@') ? typed.split('@')[0]!.split(/[._+-]/)[0]! : typed
      const result = resolveRosterName(query, roster)
      if (result.kind === 'match' && /^emp_[A-Za-z0-9_-]{1,120}$/.test(result.person.id)) {
        persons.push(result.person)
      } else {
        unresolved.push(typed)
      }
    }
    return { ...request, persons, unresolved }
  })
}

/** Whether a prompt asks to wait for anything at all: the one question the hook pointer asks. */
export function hasNextOutcomeWaitRequest(prompt: string): boolean {
  return nextOutcomeWaitRequests(prompt).length > 0
}
