/**
 * Whether a missing deliverable gets a repair prompt now, and the fixed words of that prompt. The
 * prompt names paths and plain reasons only: never file contents, never the agent's own words, so
 * nothing a session wrote can turn it into an approval.
 */

import type {
  DeliverableAction,
  DeliverableCheck,
  DeliverableOverall
} from '../../shared/deliverable-verification-types'
import type { DeliverableVerifierMode } from '../../shared/deliverable-verifier-settings'

export const DELIVERABLE_REPAIR_PROMPT_MAX = 2_000
/** A hard stop whatever a turn is read as answering: no conversation gets more in an hour. */
export const DELIVERABLE_REPAIRS_PER_CONVERSATION_HOUR = 3
export const DELIVERABLE_REPAIR_WINDOW_MS = 60 * 60_000

export type DeliverableRepairFacts = {
  mode: Exclude<DeliverableVerifierMode, 'off'>
  maxRepairs: number
  overall: DeliverableOverall
  checks: readonly DeliverableCheck[]
  repairsSent: number
  /** Repairs sent on this conversation in the last `DELIVERABLE_REPAIR_WINDOW_MS`, any request. */
  conversationRepairsInWindow: number
  /** Targets still missing when the previous repair was sent; null when this turn answers none. */
  missingBeforeRepair: readonly string[] | null
  replyAsksPerson: boolean
  agentWaiting: boolean
  pendingQuestion: boolean
  keepGoing: boolean
  /** Anything queued for it (the person's message, the steward's prompt), or a failed message of
   *  the person's holding the queue. */
  queuedEntry: boolean
}

export type DeliverableRepairDecision = {
  action: DeliverableAction
  missing: DeliverableCheck[]
}

export function deliverableMissing(checks: readonly DeliverableCheck[]): DeliverableCheck[] {
  return checks.filter((check) => check.verdict === 'missing')
}

const BLOCKERS: [keyof DeliverableRepairFacts, DeliverableAction][] = [
  ['replyAsksPerson', 'skipped:asks-person'],
  ['agentWaiting', 'skipped:agent-waiting'],
  ['pendingQuestion', 'skipped:pending-question'],
  ['keepGoing', 'skipped:keep-going'],
  ['queuedEntry', 'skipped:queued-message']
]

/** `repair-sent` here means "send one": the caller records `repair-sent` only once it is queued. */
export function decideDeliverableRepair(facts: DeliverableRepairFacts): DeliverableRepairDecision {
  const missing = deliverableMissing(facts.checks)
  if (facts.overall !== 'incomplete' || missing.length === 0) {
    return { action: 'none', missing }
  }
  // Progress is an item the last repair fixed; a turn that fixed none of them stops here.
  if (facts.missingBeforeRepair) {
    const now = new Set(missing.map((check) => check.target))
    if (facts.missingBeforeRepair.every((target) => now.has(target))) {
      return { action: 'stopped:no-progress', missing }
    }
  }
  if (facts.repairsSent >= facts.maxRepairs) {
    return { action: 'exhausted', missing }
  }
  if (facts.conversationRepairsInWindow >= DELIVERABLE_REPAIRS_PER_CONVERSATION_HOUR) {
    return { action: 'skipped:hourly-cap', missing }
  }
  const blocked = BLOCKERS.find(([fact]) => facts[fact] === true)
  if (blocked) {
    return { action: blocked[1], missing }
  }
  return { action: facts.mode === 'on' ? 'repair-sent' : 'would-repair', missing }
}

function why(check: DeliverableCheck): string {
  switch (check.source) {
    case 'request':
      return 'you were asked to write it there'
    case 'prep':
      return 'it is on the Done when list'
    case 'mission':
      return 'it is a listed deliverable'
    case 'claim':
      return check.claim === 'named'
        ? 'your reply names it'
        : `your reply says it was ${check.claim}`
  }
}

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function deliverableRepairMarker(attempt: number, max: number, token: string): string {
  return `[from Deliverable check ${attempt}/${max} · dv-${token}]`
}

const MARKER = /^\s*\[from Deliverable check (\d+)\/(\d+) · dv-([a-z0-9]{4,32})\]/

/** The marker a repair prompt starts with, read back from the prompt the next turn answers. */
export function parseDeliverableRepairMarker(
  prompt: string | undefined
): { attempt: number; max: number; token: string } | null {
  const match = prompt ? MARKER.exec(prompt) : null
  return match ? { attempt: Number(match[1]), max: Number(match[2]), token: match[3]! } : null
}

export function deliverableRepairPrompt(input: {
  attempt: number
  max: number
  token: string
  missing: readonly DeliverableCheck[]
  checkedAt: number
}): string {
  const head = `${deliverableRepairMarker(input.attempt, input.max, input.token)} Before this is finished, these items were not found:`
  const tail = [
    'Create or fix each one. If one cannot be done, say which and why instead of retrying it.',
    'Do not take any irreversible or outward-facing step that this conversation has not already approved.',
    'Then list each deliverable with its path or link.'
  ].join('\n')
  const lines: string[] = []
  let used = head.length + tail.length + 2
  for (const [index, check] of input.missing.entries()) {
    const line = `${index + 1}. ${check.target} (${why(check)}) — ${check.detail}, checked ${clock(input.checkedAt)}.`
    const more = input.missing.length - index
    const reserve = index < input.missing.length - 1 ? 40 : 0
    if (used + line.length + 1 + reserve > DELIVERABLE_REPAIR_PROMPT_MAX) {
      lines.push(`…and ${more} more.`)
      break
    }
    const shown = line.slice(0, 600)
    lines.push(shown)
    used += shown.length + 1
  }
  return [head, ...lines, tail].join('\n').slice(0, DELIVERABLE_REPAIR_PROMPT_MAX)
}
