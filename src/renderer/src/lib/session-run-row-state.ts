import { translate } from '@/i18n/i18n'
import { sessionChainErrorMessage } from '@/lib/session-chain-error'
import { eventWaitHeadline } from '@/lib/session-run-event-wait'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  openHumanAttentionRequests,
  type HumanAttentionRequest
} from '../../../shared/session-human-attention'
import { readSessionRun, type SessionRunPhase } from '../../../shared/session-run-lifecycle'

/**
 * THE reading every row, group, counter and caption takes of a plan. It asks the one run policy
 * (`readSessionRun`) and adds only what a list needs: where the row goes and what its line says.
 * "Needs you" is an open request addressed to the owner and nothing else
 * (`docs/reference/session-run-lifecycle.md`).
 */
export type SessionRunRowPhase = SessionRunPhase | 'cancelled'

export type SessionRunRowGroup =
  | 'attention'
  | 'conversations'
  | 'waiting'
  | 'completed'
  | 'archived'
  | 'saved'
  | 'stopped'

export type SessionRunRowState = {
  phase: SessionRunRowPhase
  /** The one line a person reads for this run. */
  headline: string
  /** The `why` of a request, or the full diagnostic of a failure: for expandable details only. */
  detail?: string
  /** Open requests addressed to the owner: the whole of "needs you". */
  requests: HumanAttentionRequest[]
  /** Whether this row adds one to every "N need you". Put-away rows never do. */
  countsAsAttention: boolean
  group: SessionRunRowGroup
  /** Sealed, failed or cancelled: nothing is queued and nothing will ask any more. */
  settled: boolean
  /** Whether a worker of the current plan is running right now. */
  running: boolean
  /** When the run was sealed, for the Completed caption. */
  completedAt?: number
}

export type SessionRunRowFlags = {
  now: number
  archived?: boolean
  saved?: boolean
  snoozed?: boolean
}

const FAILURE_SUMMARY_MAX = 120
// Why one shared array: a row without requests must stay value-equal across rebuilds.
const NO_REQUESTS: HumanAttentionRequest[] = []

/** The first sentence of a reason; a long explanation reads as one clause on the row. */
export function firstSentence(text: string): string {
  const trimmed = text.trim()
  const match = /^(.*?[.!?])(?:\s|$)/.exec(trimmed)
  return match ? match[1]! : trimmed
}

function failureSummary(reason: string): string {
  const sentence = firstSentence(reason)
  return sentence.length > FAILURE_SUMMARY_MAX
    ? `${sentence.slice(0, FAILURE_SUMMARY_MAX - 1)}…`
    : sentence
}

function failedHeadline(reason: string | undefined): string {
  return reason
    ? translate('conversations.runFailed', 'Failed · {{summary}}', {
        summary: failureSummary(reason)
      })
    : translate('conversations.runFailedBare', 'Failed')
}

/** "Needs you: <ask>": the ask is the host's own sentence, never a blocked reason. */
export function needsYouHeadline(requests: readonly HumanAttentionRequest[]): string {
  const ask = requests[0]?.ask ?? ''
  return requests.length > 1
    ? translate('conversations.runNeedsYouMore', 'Needs you: {{ask}} · +{{count}} more', {
        ask,
        count: requests.length - 1
      })
    : translate('conversations.runNeedsYou', 'Needs you: {{ask}}', { ask })
}

function wakeLabel(wake: string | undefined): string {
  if (!wake || wake === 'evidence') {
    return translate('conversations.wakeEvidence', 'evidence')
  }
  return wake === 'execution host'
    ? translate('conversations.wakeExecutionHost', 'the execution host to reconnect')
    : wake
}

function rowGroup(
  phase: SessionRunRowPhase,
  flags: SessionRunRowFlags,
  running: boolean
): SessionRunRowGroup {
  if (flags.saved) {
    return 'saved'
  }
  if (flags.archived) {
    return 'archived'
  }
  if (phase === 'completed') {
    return 'completed'
  }
  if (phase === 'failed' || phase === 'cancelled') {
    return 'stopped'
  }
  if (running) {
    return 'conversations'
  }
  // A snooze hides a suspended request until the person's chosen time.
  if (flags.snoozed) {
    return 'waiting'
  }
  return phase === 'needs-you' ? 'attention' : running ? 'conversations' : 'waiting'
}

/** Only the current strategy speaks for the run; earlier attempts remain history. */
export function currentPlanAttempts(chain: SessionChain) {
  const version = chain.planVersion ?? 1
  const steps = new Map(
    chain.steps.filter((step) => step.kind !== 'handoff').map((step) => [`step_${step.id}`, step])
  )
  const current = (chain.outcomeSet?.attempts ?? []).filter(
    (attempt) =>
      attempt.state !== 'superseded' &&
      (attempt.planVersion ?? steps.get(attempt.actionId)?.planVersion ?? 1) === version
  )
  return [...new Map(current.map((attempt) => [attempt.actionId, attempt])).values()]
}

function runningNow(chain: SessionChain): boolean {
  const asking = new Set(
    chain.outcomeSet
      ? openHumanAttentionRequests(chain.outcomeSet, chain.planVersion).map(
          (request) => request.scope.attemptId
        )
      : []
  )
  return currentPlanAttempts(chain).some(
    (attempt) =>
      !asking.has(attempt.id) && (attempt.state === 'running' || attempt.state === 'launching')
  )
}

function phaseOf(chain: SessionChain, now: number) {
  const set = chain.outcomeSet
  const run = set ? readSessionRun(set, { now, planVersion: chain.planVersion }) : null
  // Why `done` too: the host writes it in the same durable write as the seal, so a record from
  // before the seal existed is still a finished run, whatever its host contact says today.
  if (run?.phase === 'completed' || chain.state === 'done') {
    return { run, phase: 'completed' as const }
  }
  if (chain.state === 'cancelled') {
    return { run, phase: 'cancelled' as const }
  }
  if (chain.state === 'failed' && run?.phase !== 'needs-you') {
    return { run, phase: 'failed' as const }
  }
  return { run, phase: run?.phase ?? ('active' as const) }
}

export function sessionRunRowState(
  chain: SessionChain,
  flags: SessionRunRowFlags
): SessionRunRowState {
  const { run, phase } = phaseOf(chain, flags.now)
  const requests = phase === 'needs-you' ? (run?.attention ?? NO_REQUESTS) : NO_REQUESTS
  const running =
    !['completed', 'failed', 'cancelled'].includes(phase) &&
    chain.outcomeSet?.continuation.state === 'owned' &&
    runningNow(chain)
  const base = {
    phase,
    requests,
    group: rowGroup(phase, flags, running),
    settled: phase === 'completed' || phase === 'failed' || phase === 'cancelled',
    running,
    countsAsAttention: requests.length > 0 && !flags.archived && !flags.saved && !flags.snoozed
  }
  switch (phase) {
    case 'completed': {
      const completedAt = run?.completion?.at ?? chain.outcomeSet?.updatedAt ?? chain.updatedAt
      return {
        ...base,
        completedAt,
        headline: translate('conversations.planFinished', 'Plan finished · complete')
      }
    }
    case 'needs-you':
      return { ...base, headline: needsYouHeadline(requests), detail: requests[0]!.why }
    case 'recovering':
      return {
        ...base,
        headline: translate('conversations.runRecovering', 'Recovering · retrying automatically'),
        ...(run?.reasons.length ? { detail: run.reasons.join('\n') } : {})
      }
    case 'waiting':
      return {
        ...base,
        headline:
          eventWaitHeadline(chain, run?.wake, flags.now) ??
          translate('conversations.runWaitingFor', 'Waiting for {{wake}}', {
            wake: wakeLabel(run?.wake)
          }),
        ...(run?.reasons.length ? { detail: run.reasons.join('\n') } : {})
      }
    case 'failed': {
      const reason =
        run?.failure?.reason ??
        run?.reasons[0] ??
        (chain.error ? sessionChainErrorMessage(chain.error) : undefined)
      const detail = run?.reasons.length ? run.reasons.join('\n') : reason
      return { ...base, headline: failedHeadline(reason), ...(detail ? { detail } : {}) }
    }
    case 'cancelled':
      return { ...base, headline: translate('conversations.runCancelled', 'Cancelled') }
    case 'active':
      return {
        ...base,
        headline: base.running
          ? translate('workPlan.running', 'Running')
          : translate('workPlan.queued', 'Queued')
      }
  }
}

/** The reading as of now, for a surface that shows one plan and keeps no clock of its own. */
export function currentSessionRunRowState(chain: SessionChain): SessionRunRowState {
  return sessionRunRowState(chain, { now: Date.now() })
}

/** Open owner requests of every listed chain, once each: what the counters add up. */
export function sessionRunRequests(
  chains: readonly SessionChain[],
  now: number
): { chain: SessionChain; request: HumanAttentionRequest }[] {
  return chains.flatMap((chain) =>
    chain.outcomeSet
      ? sessionRunRowState(chain, { now }).requests.map((request) => ({ chain, request }))
      : []
  )
}
