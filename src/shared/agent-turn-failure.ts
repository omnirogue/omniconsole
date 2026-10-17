// ─── A turn that ended in failure, and what the agent said killed it ─────────
// Why: providers report a failed turn on a boundary of its own (Claude's StopFailure);
// flattening it into the same `done` a successful turn emits leaves a dead agent looking
// finished. The flag lives on the status payload; the text below is the only place that
// decides how the death is worded, so no consumer has to pattern-match provider prose.

import { readFirstString } from './agent-hook-listener/interactive-tool'
import { isProviderUsageLimitText } from './provider-usage-limit-text'

/** Bounded so a runaway provider cannot grow the per-pane status cache or a dispatch's last_error. */
export const AGENT_TURN_FAILURE_REASON_MAX_LENGTH = 1_000

/**
 * The failing turn's own explanation, in the order a person would read it: the last line the
 * agent printed (a quota wall, an expired sign-in), then the provider's error detail, then its
 * error code. Absent when the provider said nothing at all — an unknown death still fails, it
 * just fails without a quote.
 */
export function readAgentTurnFailureReason(
  hookPayload: Record<string, unknown>
): string | undefined {
  const raw = readFirstString(hookPayload, [
    'last_assistant_message',
    'lastAssistantMessage',
    'error_details',
    'errorDetails',
    'error',
    'reason',
    'message'
  ])
  const collapsed = raw?.replace(/\s+/g, ' ').trim()
  if (!collapsed) {
    return undefined
  }
  return collapsed.length > AGENT_TURN_FAILURE_REASON_MAX_LENGTH
    ? collapsed.slice(0, AGENT_TURN_FAILURE_REASON_MAX_LENGTH)
    : collapsed
}

/**
 * Recognized causes carry a recovery hint. This is deliberately not the only path: an
 * unrecognized reason (or none at all) still produces a loud failure below, because the
 * defect this fixes was silence, not a missing vendor string.
 */
export type AgentTurnFailureKind = 'usage-limit' | 'authentication' | 'unknown'

export function classifyAgentTurnFailure(reason: string | undefined): AgentTurnFailureKind {
  if (!reason) {
    return 'unknown'
  }
  const text = reason.toLowerCase()
  if (
    isProviderUsageLimitText(text) ||
    text.includes('hit your limit') ||
    text.includes('rate_limit_error') ||
    text.includes('usage credit') ||
    text.includes('usage limit') ||
    text.includes('out of credit') ||
    text.includes('insufficient credit') ||
    text.includes('insufficient balance') ||
    text.includes('credit balance is too low') ||
    text.includes('credits exhausted') ||
    text.includes('payment required') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('insufficient_quota')
  ) {
    return 'usage-limit'
  }
  if (
    text.includes('not authenticated') ||
    text.includes('unauthenticated') ||
    text.includes('unauthorized') ||
    text.includes('authentication') ||
    text.includes('invalid api key') ||
    text.includes('please log in') ||
    text.includes('please sign in') ||
    text.includes('session expired') ||
    text.includes('token expired') ||
    text.includes('expired token')
  ) {
    return 'authentication'
  }
  return 'unknown'
}

function hint(kind: AgentTurnFailureKind): string {
  if (kind === 'usage-limit') {
    return ' Wait for capacity to reset or use another eligible account before continuing unfinished work.'
  }
  if (kind === 'authentication') {
    return ' Sign that agent’s CLI in again, then run the step again.'
  }
  return ' Open that conversation to see what happened, then run the step again.'
}

/**
 * The sentence a person reads when a step’s agent died. Always names the failure; quotes the
 * agent’s own last line whenever there is one, so a quota wall reads as a quota wall instead
 * of “step failed”.
 */
export function describeAgentTurnFailure(reason: string | undefined): string {
  const kind = classifyAgentTurnFailure(reason)
  const lead = reason
    ? `The agent stopped without finishing: ${reason}`
    : 'The agent stopped without finishing and reported no reason.'
  return `${lead}${hint(kind)}`
}

/** A stall nothing reported: the dispatch never settled and no activity was observed in its own budget. */
export function describeWorkerDispatchStall(args: {
  timeoutMs: number
  agentTurnEnded: boolean
  reason?: string
}): string {
  const seconds = Math.round(args.timeoutMs / 1000)
  if (args.agentTurnEnded) {
    return args.reason
      ? `The agent's session ended without reporting a result: ${args.reason} Nothing has run for ${seconds}s, so this step is not still working.`
      : `The agent's session ended without reporting a result and nothing has run for ${seconds}s. Open that conversation to see what happened, then run the step again.`
  }
  return `No activity was observed for ${seconds}s after this step's instruction was accepted, so the step is not running. Open that conversation to see what happened, then run the step again.`
}
