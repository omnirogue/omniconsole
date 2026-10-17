import type { DashboardBucket } from '../../../shared/dashboard-snapshot'
import { useEffect, useState } from 'react'
import type { AgentDotState } from '@/components/AgentStateDot'
import { isLiveSessionChain, type SessionChain } from '../../../shared/session-chain-types'
import { sessionCommitmentProof } from '../../../shared/session-archive-proof'
import { sessionSealAwaitsOthers } from '../../../shared/session-seal-awaits-others'
import { describeSessionChain } from './session-chain-summary'
import { sessionRunRowState } from './session-run-row-state'

export {
  CONVERSATION_ARCHIVED_AFTER_MS,
  CONVERSATION_COMPLETED_AFTER_MS
} from '../../../shared/conversation-retention-window'
export type ConversationCompletion = {
  reason: 'finished' | 'handed' | 'done'
  at: number
  handedTo?: string
}

export function classifyConversation(input: {
  now: number
  launchPending?: boolean
  state: AgentDotState | null
  canonicalBucket?: DashboardBucket
  finishedAt?: number
  stateChangedAt?: number
  retainedStartedAt?: number
  waitingUntil: string | null
  /** When this device first listed the row; the last resort for a row with no known time. */
  firstSeenAt?: number
  attention: boolean
  /** The steward tried and could not move it: shown beside Needs you until its next turn. */
  stalled?: boolean
  /** A plan ended with ↩ Back to me and nobody has opened the row since. */
  returned?: boolean
  unavailable: boolean
  chain?: SessionChain | null
  archived?: boolean
  working?: boolean
}): {
  group: 'conversations' | 'attention' | 'waiting' | 'completed' | 'archived' | 'stopped'
  completed: ConversationCompletion | null
} {
  if (input.archived) {
    // Why: putting a row away is not finishing it — the caption keeps whatever the row
    // actually knows about its end, and nothing underneath is stopped.
    const derived = classifyConversation({ ...input, archived: false })
    return { group: 'archived', completed: derived.completed }
  }
  if (input.stalled && !input.attention) {
    return classifyConversation({ ...input, stalled: false, attention: true })
  }
  const { chain, now } = input
  const result = (group: 'conversations' | 'attention' | 'waiting' | 'stopped') => ({
    group,
    completed: null
  })
  if (input.launchPending) {
    return result('waiting')
  }
  const sealedAt = chain?.outcomeSet?.completion?.at
  const freshExecution =
    (input.working ?? input.state === 'working') &&
    !input.unavailable &&
    (sealedAt === undefined || (input.stateChangedAt ?? 0) > sealedAt)
  if (freshExecution) {
    return result('conversations')
  }
  // Committed outcomes own the lifecycle; pane exit, age and old attention marks are not completion evidence.
  if (chain?.outcomeSet && chain.state !== 'cancelled') {
    const run = sessionRunRowState(chain, { now, snoozed: input.waitingUntil !== null })
    if (run.phase === 'completed') {
      if (input.state === 'monitoring') {
        return result('waiting')
      }
      const at = run.completedAt ?? chain.outcomeSet.updatedAt
      // Why the fence: only work or a question NEWER than the finish is the conversation's own;
      // a late heartbeat of the finished run must not pull a completed row back.
      const since = (input.stateChangedAt ?? 0) > at
      if (since && input.unavailable && input.state === 'working') {
        return result('waiting')
      }
      if (since && input.working) {
        return result('conversations')
      }
      if (since && input.attention) {
        return result('attention')
      }
      // Why: a seal still waiting on a merge, another party's review or a handoff recipient has a
      // wake outside this conversation. Anything else the seal left unproven is Done, finished:
      // whether it may leave the list by itself is sessionArchiveProof's question, not this group's.
      if (sessionSealAwaitsOthers(chain)) {
        return result('waiting')
      }
      return {
        group: 'completed',
        completed: { reason: sessionCommitmentProof(chain) ? 'done' : 'finished', at }
      }
    }
    if (run.running && !input.unavailable) {
      return result('conversations')
    }
    if (input.unavailable || run.group === 'waiting') {
      return result('waiting')
    }
    if (run.settled) {
      return result('stopped')
    }
    // Why the second case: before the run owns its source, that conversation's own question is
    // still the person's to answer. A blocked, failed or silent run is never a question.
    return result(
      run.phase === 'needs-you' ||
        (input.attention && !run.settled && !chain.outcomeSet.continuation.sourceReady)
        ? 'attention'
        : run.running
          ? 'conversations'
          : 'waiting'
    )
  }
  if (!input.working && input.finishedAt && (input.stateChangedAt ?? 0) <= input.finishedAt) {
    return { group: 'completed', completed: { reason: 'done', at: input.finishedAt } }
  }
  // Why: only a snooze outranks a question; a plan whose current step asks something still needs you.
  if (input.waitingUntil) {
    return result('waiting')
  }
  if (input.attention || input.returned) {
    return result('attention')
  }
  if (input.state === 'failed' || input.state === 'interrupted') {
    return result('stopped')
  }
  if (input.unavailable && input.state !== 'done') {
    return result('waiting')
  }
  if (input.state === 'monitoring') {
    return result('waiting')
  }
  // Why: a plan that waits for the person's "Start next" click is a question, not running work,
  // and so is a plan parked on a pane that asked something.
  if (chain?.state === 'ready' || (chain && isLiveSessionChain(chain) && chain.blocked)) {
    return result('attention')
  }
  // Why: contact with the host is not evidence about the plan — an unverifiable row must stay
  // visible as Waiting until its host can verify execution.
  if (chain && isLiveSessionChain(chain) && !input.unavailable) {
    return result('waiting')
  }
  // Why: a plan that could not go on is an honest failure in plain sight; a legacy plan handed to a
  // person waits on them, which is a wake outside this conversation.
  if (chain?.state === 'failed') {
    return result('stopped')
  }
  if (chain?.state === 'done' && describeSessionChain(chain)?.handedTo) {
    return result('waiting')
  }
  if (input.state === 'working') {
    return result('conversations')
  }
  // Why: a reported finished turn or an observed idle prompt is Done as a person reads it. It is
  // not a claim that the whole commitment is complete: only a sealed plan can prove that, so the
  // caption says "finished", and sessionArchiveProof (never this group) decides what may leave.
  // No state report is missing evidence, never evidence of a finished turn.
  if (input.state === 'done' || input.state === 'idle') {
    return { group: 'completed', completed: { reason: 'finished', at: finishedTurnAt(input, now) } }
  }
  return result('waiting')
}

const usableTime = (at: number | undefined): at is number =>
  typeof at === 'number' && Number.isFinite(at) && at > 0

/** When the turn ended, as best the row knows: its state change, its retained start, first sight. */
function finishedTurnAt(
  input: { stateChangedAt?: number; retainedStartedAt?: number; firstSeenAt?: number },
  now: number
): number {
  return [input.stateChangedAt, input.retainedStartedAt, input.firstSeenAt].find(usableTime) ?? now
}

/** A finished conversation's age in the unit a person would say: minutes, hours or days. */
export function conversationAge(ms: number): { unit: 'minute' | 'hour' | 'day'; count: number } {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) {
    return { unit: 'minute', count: minutes }
  }
  const hours = Math.round(minutes / 60)
  return hours < 48
    ? { unit: 'hour', count: hours }
    : { unit: 'day', count: Math.round(hours / 24) }
}

export function useMinuteTick(wakeTimes?: Readonly<Record<string, number>>): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(ticker)
  }, [])
  useEffect(() => {
    const next = Math.min(...Object.values(wakeTimes ?? {}).filter((at) => at > now))
    if (!Number.isFinite(next)) {
      return
    }
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(2_147_483_647, Math.max(0, next - Date.now()))
    )
    return () => clearTimeout(timer)
  }, [wakeTimes, now])
  return now
}
