import { z } from 'zod'

/**
 * An `event` condition: something outside the IDE has to happen before the plan moves on — a named
 * person's approval on Slack, email or Jira, a sign-in, a GitHub review or merge, or a time.
 * The contract with omnios is `~/Work/Ops/Plans/Conversational-Waits-2026-09-24/CONTRACT.md` §2:
 * omnios only answers "has this happened yet?"; waiting, continuing and finishing stay here.
 */
export const SESSION_OUTCOME_EVENT_SOURCES = [
  'slack',
  'email',
  'jira',
  'signin',
  'github',
  'time',
  'session'
] as const
export type SessionOutcomeEventSource = (typeof SESSION_OUTCOME_EVENT_SOURCES)[number]

/**
 * How the turn a cleared wait sends into its conversation begins. That turn becomes the
 * conversation's latest prompt, so every chat parser ignores it: it must never file a wait again.
 */
export const SESSION_OUTCOME_WAIT_BRIEF_MARKER = '[OmniConsole] Next step of the plan you filed'

/** How a wait nobody can check reads, on the host's block and on the row alike. */
export const SESSION_OUTCOME_WAIT_UNAVAILABLE_PREFIX = 'Follow-up not scheduled:'

/** Sources whose facts come from omnios `GET /api/waits/facts`; the rest are read on this host. */
export const OMNIOS_EVENT_SOURCES: ReadonlySet<SessionOutcomeEventSource> = new Set([
  'slack',
  'email',
  'jira',
  'signin'
])

const iso = z.string().datetime({ offset: true })
const personId = z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/)
const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,9}$/
const GITHUB_PR =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/
const ASK_HANDLE = /^(?:slack|email):[^\s:]{1,200}:[^\s]{1,300}$/
const APP_KEY = /^[a-z][a-z0-9_-]{1,40}$/
/** A pane key as `omni session list` prints it; which session it is, the host checks at commit. */
const SESSION_PANE_KEY = /^\S{1,400}$/

export const sessionOutcomeEventSchema = z
  .object({
    source: z.enum(SESSION_OUTCOME_EVENT_SOURCES),
    match: z.enum(['approve', 'reply', 'signin', 'review', 'merged', 'at', 'result']),
    personId: personId.optional(),
    /** Display only; the host fills it from the roster when the plan is filed. */
    personName: z.string().trim().min(1).max(80).optional(),
    /** The ask handle, Jira key, sign-in app key, PR URL or awaited session's pane key, by source. */
    ref: z.string().trim().min(1).max(512).optional(),
    since: iso.optional(),
    at: iso.optional(),
    deadline: iso.optional(),
    onDeadline: z.literal('ask-owner').optional()
  })
  .strict()
  .superRefine((event, ctx) => {
    const problem = sessionOutcomeEventProblem(event)
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem })
    }
  })
export type SessionOutcomeEvent = z.infer<typeof sessionOutcomeEventSchema>

const MATCHES: Record<SessionOutcomeEventSource, readonly SessionOutcomeEvent['match'][]> = {
  slack: ['approve', 'reply'],
  email: ['approve', 'reply'],
  jira: ['approve', 'reply'],
  signin: ['signin'],
  github: ['review', 'merged'],
  time: ['at'],
  session: ['result']
}

/** What makes an event unreadable, in words the agent that filed it can fix; null when it is fine. */
export function sessionOutcomeEventProblem(event: SessionOutcomeEvent): string | null {
  if (!MATCHES[event.source].includes(event.match)) {
    return `A ${event.source} wait matches ${MATCHES[event.source].join(' or ')}.`
  }
  if (event.onDeadline && !event.deadline) {
    return 'onDeadline needs a deadline.'
  }
  if (event.source === 'time') {
    return event.at ? null : 'A time wait needs `at`.'
  }
  if (event.source === 'session') {
    if (event.personId) {
      return 'A session wait names no person.'
    }
    return event.ref && SESSION_PANE_KEY.test(event.ref)
      ? null
      : 'A session wait needs `ref`: the pane key `omni outcome wait --on-session` printed.'
  }
  if (event.source === 'github') {
    return event.ref && GITHUB_PR.test(event.ref)
      ? null
      : 'A GitHub wait needs `ref`: the pull request URL (https://github.com/<owner>/<repo>/pull/<n>).'
  }
  if (!event.personId) {
    return `A ${event.source} wait needs the person's roster id (emp_…).`
  }
  if (!event.since) {
    return `A ${event.source} wait needs \`since\`: only what happens after it counts.`
  }
  if (event.source === 'jira') {
    return event.ref && JIRA_KEY.test(event.ref) ? null : 'A Jira wait needs `ref`: the issue key.'
  }
  if (event.source === 'signin') {
    return event.ref && APP_KEY.test(event.ref) ? null : 'A sign-in wait needs `ref`: the app key.'
  }
  // No handle means the ask never went out: the wait is filed and reads "not scheduled".
  return !event.ref || ASK_HANDLE.test(event.ref)
    ? null
    : `A ${event.source} wait's \`ref\` is the handle the ask returned.`
}

/** "on Slack", "by email": how a row names where the answer comes from. */
export function sessionOutcomeEventSourceLabel(source: SessionOutcomeEventSource): string {
  switch (source) {
    case 'slack':
      return 'on Slack'
    case 'email':
      return 'by email'
    case 'jira':
      return 'on Jira'
    case 'signin':
      return 'sign-in'
    case 'github':
      return 'on GitHub'
    case 'time':
      return 'time'
    case 'session':
      return 'session result'
  }
}

/**
 * The last reading of one event condition. Runtime, never definition: it lives on the outcome
 * beside the receipts, is rewritten by each poll, and a revision that drops it loses nothing the
 * next poll does not read again.
 */
export const sessionOutcomeWaitFactSchema = z
  .object({
    conditionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    status: z.enum(['met', 'pending', 'needs_you', 'unavailable']),
    checkedAt: z.number().finite().nonnegative(),
    reason: z.string().trim().min(1).max(400).optional(),
    excerpt: z.string().trim().min(1).max(400).optional(),
    by: z.string().trim().min(1).max(80).optional(),
    link: z.string().trim().min(1).max(1_000).optional(),
    at: z.number().finite().nonnegative().optional(),
    /** The owner said "keep waiting" at this time: only what happens after it counts now. */
    rearmedAt: z.number().finite().nonnegative().optional(),
    /** The answer this reading was about, so a re-armed wait can tell a new answer from it. */
    answerId: z.string().trim().min(1).max(400).optional()
  })
  .strict()
export type SessionOutcomeWaitFact = z.infer<typeof sessionOutcomeWaitFactSchema>

/** The moment an event's answer must come after: its own `since`, or the owner's last re-arm. */
export function sessionOutcomeEventSince(
  event: SessionOutcomeEvent,
  fact: SessionOutcomeWaitFact | undefined
): string | undefined {
  const since = event.since ? Date.parse(event.since) : undefined
  const rearmed = fact?.rearmedAt
  if (rearmed !== undefined && (since === undefined || rearmed > since)) {
    return new Date(rearmed).toISOString()
  }
  return event.since
}
