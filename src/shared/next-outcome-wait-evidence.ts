import type { ResolvedNextOutcomeWait } from './next-outcome-wait-request'
import type { SessionOutcomeCondition } from './session-outcome-types'

const DAY = 24 * 60 * 60_000
/** A wait further out than this is not something anyone asked a conversation to sit on. */
const LONGEST_WAIT = 90 * DAY

function plausibleFuture(iso: string | undefined, now: number): boolean {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at) && at >= now - 5 * 60_000 && at <= now + LONGEST_WAIT
}

/** `since` is when the ask went out: recent, never ahead of now, so an old answer cannot count. */
function plausibleSince(iso: string | undefined, now: number): boolean {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(at) && at >= now - DAY && at <= now + 5 * 60_000
}

/**
 * Whether the attested prompt asked for exactly this wait. The agent writes the plan; the host only
 * admits a wait on a person the prompt named (resolved against the roster, never an id the agent
 * made up), through the channel the prompt named, for the kind of answer the prompt asked for.
 */
export function nextOutcomeWaitEvidenced(
  condition: SessionOutcomeCondition,
  prompt: string,
  waits: readonly ResolvedNextOutcomeWait[],
  now = Date.now()
): boolean {
  const event = condition.event
  if (condition.kind !== 'event' || !event) {
    return false
  }
  if (event.deadline || event.onDeadline) {
    if (
      !plausibleFuture(event.deadline, now) ||
      !waits.some((request) => request.kind === 'deadline')
    ) {
      return false
    }
  }
  if (event.source === 'time') {
    return (
      plausibleFuture(event.at, now) &&
      waits.some((request) => request.kind === 'time' || request.kind === 'deadline')
    )
  }
  // Which session, and that it is not this one, a remote one or a circle, is the host's reading at
  // commit (`session-wait-admission.ts`); the prompt only has to ask to wait for a session.
  if (event.source === 'session') {
    return waits.some((request) => request.kind === 'session')
  }
  if (event.source === 'github') {
    return waits.some(
      (request) =>
        request.kind === 'github' &&
        request.ref === event.ref &&
        request.match === event.match &&
        prompt.includes(event.ref!)
    )
  }
  if (!plausibleSince(event.since, now)) {
    return false
  }
  return waits.some(
    (request) =>
      request.source === event.source &&
      request.persons.some((person) => person.id === event.personId) &&
      (event.source === 'signin'
        ? !request.ref || request.ref === event.ref
        : request.match === event.match ||
          (request.match === 'reply' && event.match === 'approve')) &&
      (event.source !== 'jira' || request.ref === event.ref)
  )
}
