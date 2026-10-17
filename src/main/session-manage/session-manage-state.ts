/**
 * Where a conversation stands, in the companion plan's words, from what this host could observe.
 * Conservative by construction: anything the host could not read is `unknown`, and loss of contact
 * with a host is `unverifiable` (state `unknown`), never `exited`.
 */

import type { SessionExecutionVerdict, SessionManageState } from '../../shared/session-manage-types'

/** What the agent itself is doing, read from its hook row or its chat host. */
export type SessionAgentActivity =
  | { kind: 'working'; activity?: string }
  | { kind: 'permission'; prompt?: string }
  | { kind: 'question'; prompt?: string }
  | { kind: 'idle'; failure?: string; usageLimited?: boolean }
  | { kind: 'unknown'; reason?: string }

export type SessionStateFacts = {
  verdict: SessionExecutionVerdict
  /** Why it is not `live`, in plain words. */
  verdictReason?: string
  activity: SessionAgentActivity
  /** A capacity-recovery receipt holds the conversation until the provider lets it continue. */
  providerLimit?: { resetAt?: number }
  /** Prompts waiting in its queue (queued or being sent). */
  queueLength: number
  /** The session's own open next steps. */
  pendingSteps: readonly string[]
  /** Its tab is still launching the agent. */
  launchPending?: boolean
  /** What its outcome plan still waits on outside the conversation (a Slack OK, a merge). */
  planWaits?: readonly string[]
}

export type ProjectedSessionState = { state: SessionManageState; waitingOn: string | null }

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function providerLimitWords(resetAt: number | undefined): string {
  return resetAt
    ? `A provider usage limit; it can continue after ${new Date(resetAt).toISOString()}.`
    : 'A provider usage limit.'
}

function idleState(
  facts: SessionStateFacts,
  activity: Extract<SessionAgentActivity, { kind: 'idle' }>
): ProjectedSessionState {
  if (facts.queueLength > 0) {
    const count = facts.queueLength
    return {
      state: 'queued',
      waitingOn: `${count} queued prompt${count === 1 ? '' : 's'}, sent as soon as it is free.`
    }
  }
  if (facts.pendingSteps.length === 1) {
    return {
      state: 'waiting-for-yes',
      waitingOn: `A yes to its own proposal: ${oneLine(facts.pendingSteps[0]!)}`
    }
  }
  if (facts.pendingSteps.length > 1) {
    return {
      state: 'waiting-for-yes',
      waitingOn: `A choice among its ${facts.pendingSteps.length} proposed next steps.`
    }
  }
  if (facts.planWaits?.length) {
    return {
      state: 'idle',
      waitingOn: `Its plan is waiting for ${oneLine(facts.planWaits.join('; '), 400)}`
    }
  }
  return {
    state: 'idle',
    waitingOn: activity.failure ? `Its last turn failed: ${oneLine(activity.failure)}` : null
  }
}

export function projectSessionState(facts: SessionStateFacts): ProjectedSessionState {
  if (facts.verdict === 'exited') {
    return {
      state: 'exited',
      waitingOn:
        facts.verdictReason ?? 'Its agent exited; the conversation history is kept and resumable.'
    }
  }
  if (facts.verdict === 'unverifiable') {
    return {
      state: 'unknown',
      waitingOn: facts.verdictReason ?? 'Its host could not be reached, so nothing is verified.'
    }
  }
  if (facts.launchPending) {
    return { state: 'unknown', waitingOn: 'It is still starting its agent.' }
  }
  const { activity } = facts
  if (facts.providerLimit || (activity.kind === 'idle' && activity.usageLimited)) {
    return {
      state: 'provider-limited',
      waitingOn: providerLimitWords(facts.providerLimit?.resetAt)
    }
  }
  switch (activity.kind) {
    case 'permission':
      return {
        state: 'awaiting-user',
        waitingOn: activity.prompt
          ? `Your answer to a permission prompt: ${oneLine(activity.prompt)}`
          : 'Your answer to a permission prompt.'
      }
    case 'question':
      return {
        state: 'awaiting-user',
        waitingOn: activity.prompt
          ? `Your answer to its question: ${oneLine(activity.prompt)}`
          : 'Your answer to its question.'
      }
    case 'working':
      return { state: 'working', waitingOn: null }
    case 'idle':
      return idleState(facts, activity)
    case 'unknown':
      return {
        state: 'unknown',
        waitingOn: activity.reason ?? 'Its agent reported no state this host can read.'
      }
  }
}
