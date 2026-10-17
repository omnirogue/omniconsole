/**
 * Reads one `event` condition (`session-outcome-event.ts`). Local sources — a time, a GitHub review
 * or merge, another session's result — are read on this host; Slack, email, Jira and sign-in facts come from omnios
 * `GET /api/waits/facts` through the signed console client. Nothing here schedules anything: the
 * verifier's own 30 s throttle, latched receipts and restart catch-up (`verifyProgress`) decide when.
 */
import {
  OMNIOS_EVENT_SOURCES,
  SESSION_OUTCOME_WAIT_UNAVAILABLE_PREFIX,
  sessionOutcomeEventSince,
  type SessionOutcomeEvent,
  type SessionOutcomeWaitFact
} from '../../shared/session-outcome-event'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import type { SessionPullRequestFacts } from '../../shared/session-pull-request-facts'
import type { SessionOutcomeVerification } from './session-outcome-evidence'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  locateAwaitedSession,
  readAwaitedSessionResult
} from '../session-steward/steward-awaited-session'

export type WaitFactsQuery = {
  source: 'slack' | 'email' | 'jira' | 'signin'
  personId: string
  ref: string
  since: string
  match: 'approve' | 'reply' | 'signin'
}

/** CONTRACT.md §1 `GET /api/waits/facts`, as the console client returns it. */
export type WaitFactsAnswer = {
  status: 'met' | 'pending' | 'needs_you' | 'unavailable'
  evidence?: {
    at: string
    by: { person_id: string; name: string }
    link: string
    excerpt?: string
    kind: string
  }
  reason?: string
  checked_at?: string
}

type Reader<Q, A> = ((query: Q) => Promise<A>) | null
let readFacts: Reader<WaitFactsQuery, WaitFactsAnswer> = null
let readPullRequest: Reader<
  { owner: string; repo: string; number: number },
  SessionPullRequestFacts | null
> = null

export function installSessionOutcomeWaitFactsReader(reader: NonNullable<typeof readFacts>): void {
  readFacts = reader
}

export function installSessionOutcomePullRequestReader(
  reader: NonNullable<typeof readPullRequest>
): void {
  readPullRequest = reader
}

/** The reading the verifier records beside the receipt; `conditionId` and re-arm are its own. */
export type SessionOutcomeWaitReading = Omit<SessionOutcomeWaitFact, 'conditionId' | 'rearmedAt'>

export type SessionOutcomeEventVerification = SessionOutcomeVerification & {
  wait: SessionOutcomeWaitReading
}

export const WAIT_UNAVAILABLE_PREFIX = SESSION_OUTCOME_WAIT_UNAVAILABLE_PREFIX

function clip(value: string | undefined, max = 400): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined
}

function unmet(
  status: 'pending' | 'needs_you' | 'unavailable',
  reason: string,
  now: number,
  extra: Partial<SessionOutcomeWaitReading> = {}
): SessionOutcomeEventVerification {
  const words = status === 'unavailable' ? `${WAIT_UNAVAILABLE_PREFIX} ${reason}` : reason
  return {
    verified: false,
    reason: words,
    wait: { status, checkedAt: now, reason: clip(reason)!, ...extra }
  }
}

function met(
  receipt: string,
  now: number,
  extra: Partial<SessionOutcomeWaitReading> = {}
): SessionOutcomeEventVerification {
  return { verified: true, receipt, wait: { status: 'met', checkedAt: now, ...extra } }
}

export function sessionOutcomeEventPerson(event: SessionOutcomeEvent): string {
  return event.personName ?? event.personId ?? 'them'
}

function parsePullRequest(url: string): { owner: string; repo: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url)
  return match ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) } : null
}

async function readGithub(
  event: SessionOutcomeEvent,
  now: number
): Promise<SessionOutcomeEventVerification> {
  const ref = parsePullRequest(event.ref ?? '')
  if (!ref) {
    return unmet('unavailable', 'Only GitHub pull request URLs can be watched.', now)
  }
  if (!readPullRequest) {
    return unmet('unavailable', 'GitHub is not readable on this host.', now)
  }
  const pr = await readPullRequest(ref).catch(() => null)
  if (!pr) {
    return unmet('unavailable', `GitHub cannot say what happened to PR #${ref.number}.`, now)
  }
  if (event.match === 'merged') {
    if (pr.state === 'merged') {
      return met(`github:${pr.url}:merged@${pr.mergeCommit ?? pr.mergedAt ?? ''}`, now, {
        link: pr.url,
        ...(pr.mergedAt ? { at: pr.mergedAt } : {})
      })
    }
    return pr.state === 'closed'
      ? unmet('needs_you', `PR #${pr.number} was closed without merging.`, now, { link: pr.url })
      : unmet('pending', `PR #${pr.number} has not merged yet.`, now, { link: pr.url })
  }
  if (pr.approved || pr.state === 'merged') {
    return met(`github:${pr.url}:approved`, now, { link: pr.url })
  }
  return pr.state === 'closed'
    ? unmet('needs_you', `PR #${pr.number} was closed without an approval.`, now, { link: pr.url })
    : unmet('pending', `PR #${pr.number} has no approving review yet.`, now, { link: pr.url })
}

async function readOmnios(
  event: SessionOutcomeEvent,
  since: string,
  now: number
): Promise<SessionOutcomeEventVerification> {
  if (!event.ref) {
    const where = event.source === 'slack' ? 'on Slack' : 'by email'
    return unmet(
      'unavailable',
      `No ask went out ${where}, so there is no reply to check. Ask again from the conversation.`,
      now
    )
  }
  if (!readFacts) {
    return unmet('unavailable', 'omnios wait facts are not connected on this host.', now)
  }
  let answer: WaitFactsAnswer
  try {
    answer = await readFacts({
      source: event.source as WaitFactsQuery['source'],
      personId: event.personId!,
      ref: event.ref!,
      since,
      match: event.match as WaitFactsQuery['match']
    })
  } catch (error) {
    return unmet('unavailable', error instanceof Error ? error.message : String(error), now)
  }
  const evidence = answer.evidence
  const at = evidence ? Date.parse(evidence.at) : Number.NaN
  const seen = {
    ...(evidence?.link ? { link: clip(evidence.link, 1_000) } : {}),
    ...(clip(evidence?.excerpt) ? { excerpt: clip(evidence?.excerpt) } : {}),
    ...(clip(evidence?.by.name, 80) ? { by: clip(evidence?.by.name, 80) } : {}),
    ...(Number.isFinite(at) ? { at } : {})
  }
  if (answer.status === 'met') {
    // Identity, not text: the fact must come from the person this condition names.
    if (!evidence || evidence.by.person_id !== event.personId || !evidence.link) {
      return unmet('unavailable', 'omnios answered without the named person’s receipt.', now)
    }
    return met(
      `event:${event.source}:${evidence.link}@${evidence.at}:${evidence.by.person_id}`,
      now,
      seen
    )
  }
  const person = sessionOutcomeEventPerson(event)
  if (answer.status === 'needs_you') {
    return unmet(
      'needs_you',
      clip(answer.reason) ?? `${person} answered, but not with an approval.`,
      now,
      seen
    )
  }
  if (answer.status === 'unavailable') {
    return unmet('unavailable', clip(answer.reason) ?? 'omnios cannot check this yet.', now, seen)
  }
  return unmet('pending', clip(answer.reason) ?? `No answer from ${person} yet.`, now, seen)
}

/**
 * Another session's result, read from this host's own records: met once it holds a Tier 1 seal or
 * a Tier 2 result card, with a receipt bound to that result's revision. A session this computer
 * does not run, or no longer holds, is "can't verify" — never met.
 */
function readSession(
  event: SessionOutcomeEvent,
  runtime: OrcaRuntimeService | undefined,
  now: number
): SessionOutcomeEventVerification {
  const ref = event.ref ?? ''
  if (!runtime) {
    return unmet('unavailable', 'Sessions are not readable on this host.', now)
  }
  const since = event.since ? Date.parse(event.since) : Number.NaN
  const location = locateAwaitedSession(runtime, ref)
  if (location.kind === 'remote') {
    return unmet(
      'unavailable',
      `The session it waits on (pane ${ref}) runs on ${location.where}, so its result can't be verified here.`,
      now
    )
  }
  const result = readAwaitedSessionResult(runtime, ref, Number.isFinite(since) ? since : undefined)
  if (result) {
    return met(`event:session:${ref}@${result.revision}`, now, {
      ...(result.at !== undefined ? { at: result.at } : {}),
      ...(result.excerpt ? { excerpt: result.excerpt } : {})
    })
  }
  if (location.kind === 'missing') {
    return unmet(
      'unavailable',
      `The session it waits on (pane ${ref}) is not open on this computer and left no recorded result, so it can't be verified.`,
      now
    )
  }
  return unmet('pending', `The session it waits on (pane ${ref}) has no finished result yet.`, now)
}

function deadlineLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** Read one event wait; `fact` is its last reading, whose re-arm moves `since` forward. */
export async function verifySessionOutcomeEvent(
  condition: SessionOutcomeCondition,
  fact: SessionOutcomeWaitFact | undefined,
  now: number,
  runtime?: OrcaRuntimeService
): Promise<SessionOutcomeEventVerification> {
  const event = condition.event
  if (condition.kind !== 'event' || !event) {
    return unmet('unavailable', 'This wait names no event.', now)
  }
  let result: SessionOutcomeEventVerification
  if (event.source === 'time') {
    const at = Date.parse(event.at ?? '')
    result =
      Number.isFinite(at) && now >= at
        ? met(`time:${event.at}`, now, { at })
        : unmet('pending', `Waiting until ${deadlineLabel(event.at ?? '')}.`, now)
  } else if (event.source === 'github') {
    result = await readGithub(event, now)
  } else if (event.source === 'session') {
    result = readSession(event, runtime, now)
  } else if (OMNIOS_EVENT_SOURCES.has(event.source)) {
    result = await readOmnios(event, sessionOutcomeEventSince(event, fact)!, now)
  } else {
    result = unmet('unavailable', `No reader for ${event.source} on this host.`, now)
  }
  const deadline = event.deadline ? Date.parse(event.deadline) : Number.NaN
  // A re-arm after the deadline is the owner choosing to keep waiting past it.
  const dismissed = fact?.rearmedAt !== undefined && fact.rearmedAt >= deadline
  if (!result.verified && result.wait.status === 'pending' && now > deadline && !dismissed) {
    return unmet(
      'needs_you',
      event.source === 'session'
        ? `The session it waits on had no result by ${deadlineLabel(event.deadline!)}.`
        : `No answer from ${sessionOutcomeEventPerson(event)} by ${deadlineLabel(event.deadline!)}.`,
      now,
      result.wait.link ? { link: result.wait.link } : {}
    )
  }
  return result
}
