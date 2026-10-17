import { principalAttention } from '../../shared/session-attention-drafts'
import type { SessionChain } from '../../shared/session-chain-types'
import { openHumanAttention } from '../../shared/session-human-attention'
import {
  sessionOutcomeBlock,
  type SessionOutcomeBlockInput
} from '../../shared/session-outcome-block'
import type { SessionOutcome, SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { sameConversationSource } from './session-outcome-conversation-turn'
import type { SourceObservation } from './session-outcome-source'

/**
 * Blocks that are about the CONTINUATION rather than about any outcome's own work: the execution
 * host, the signed principal, the source session. The host tick writes them where it observes the
 * fact and lifts them when the fact changes; the status recompute leaves them in place in between,
 * so `since` measures how long the fact has held (`docs/reference/session-run-lifecycle.md`).
 */
export const CONTINUATION_BLOCK = {
  host: 'execution-host-unverifiable',
  principal: 'principal-mismatch',
  sourceNotReady: 'source-not-ready',
  sourceGone: 'source-gone',
  sourceCapture: 'source-capture'
} as const
export type ContinuationBlockCode = (typeof CONTINUATION_BLOCK)[keyof typeof CONTINUATION_BLOCK]

const CODES: ReadonlySet<string> = new Set(Object.values(CONTINUATION_BLOCK))

export const PRINCIPAL_MISMATCH_REASON = 'Restore the original signed company/person to continue.'

export function isContinuationBlocked(outcome: Pick<SessionOutcome, 'status' | 'block'>): boolean {
  return outcome.status === 'blocked' && Boolean(outcome.block && CODES.has(outcome.block.code))
}

/** Block every unsatisfied outcome for one continuation fact; `since` survives a re-observation. */
export function blockForContinuation(
  set: SessionOutcomeSet,
  reason: string,
  block: SessionOutcomeBlockInput & { code: ContinuationBlockCode },
  now: number
): SessionOutcomeSet {
  // Never empty: the set's schema refuses a blank reason, and that would cost the whole write.
  const blockedReason = reason.trim() || 'The run cannot continue yet.'
  return {
    ...set,
    outcomes: set.outcomes.map((outcome) =>
      outcome.status === 'satisfied'
        ? outcome
        : {
            ...outcome,
            status: 'blocked',
            blockedReason,
            block: sessionOutcomeBlock(block, outcome.block, now)
          }
    )
  }
}

/** The fact no longer holds: the outcomes it held go back to the recompute, which owns the rest. */
export function liftContinuationBlocks(
  set: SessionOutcomeSet,
  codes: readonly ContinuationBlockCode[]
): SessionOutcomeSet {
  const lifted = (outcome: SessionOutcome): boolean =>
    isContinuationBlocked(outcome) && codes.includes(outcome.block!.code as ContinuationBlockCode)
  if (!set.outcomes.some(lifted)) {
    return set
  }
  return {
    ...set,
    outcomes: set.outcomes.map((outcome) =>
      lifted(outcome)
        ? { ...outcome, status: 'pending', blockedReason: undefined, block: undefined }
        : outcome
    )
  }
}

/** The signed principal changed: ONE request for the whole run, listed on every block it causes. */
export function blockForPrincipal(
  chain: Pick<SessionChain, 'planVersion'>,
  set: SessionOutcomeSet,
  now: number
): SessionOutcomeSet {
  const first = set.outcomes.find((outcome) => outcome.status !== 'satisfied')
  if (!first) {
    return set
  }
  let opened: { set: SessionOutcomeSet; id: string } | null = null
  try {
    opened = openHumanAttention(
      set,
      principalAttention({
        outcomeId: first.id,
        outcomeRevision: first.revision,
        ...(chain.planVersion ? { planVersion: chain.planVersion } : {})
      }),
      now
    )
  } catch (error) {
    console.warn('[outcomes] could not open the principal request', error)
  }
  return blockForContinuation(
    opened?.set ?? set,
    PRINCIPAL_MISMATCH_REASON,
    {
      class: 'attention',
      code: CONTINUATION_BLOCK.principal,
      ...(opened ? { attentionIds: [opened.id] } : {})
    },
    now
  )
}

/**
 * What an unready source means for the run. A source that is still working, asking its person
 * something or out of contact may yet finish, so the run waits on it; one whose pane is gone, or
 * whose native dispatch settled without succeeding, never will — and a run that can never start
 * says so instead of reading as active for ever.
 */
export function sourceContinuationBlock(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  source: SourceObservation
): { reason: string; block: SessionOutcomeBlockInput & { code: ContinuationBlockCode } } | null {
  if (source.ready) {
    return null
  }
  const native = Boolean(chain.outcomeSet?.continuation.nativeSource)
  const gone = native
    ? Boolean(source.reason) && !source.unverifiable
    : Boolean(source.unverifiable) && !sameConversationSource(runtime, chain)
  if (gone) {
    return {
      reason: source.reason ?? 'The source session is no longer available.',
      block: { class: 'failed', code: CONTINUATION_BLOCK.sourceGone }
    }
  }
  return {
    reason: source.reason ?? 'The source session has not finished its turn yet.',
    block: { class: 'waiting', code: CONTINUATION_BLOCK.sourceNotReady, wake: 'source session' }
  }
}
