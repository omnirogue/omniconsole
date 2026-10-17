import { SESSION_VERDICT_STATUSES, type SessionVerdictStatus } from './session-chain-verdict'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep,
  SessionChainVerdictReceipt
} from './session-chain-types'

/** The chain-side of a verdict: what was spent, what was skipped, and what is missing. */
export type VerdictChain = Pick<SessionChain, 'steps' | 'outcomeSet' | 'verdicts'>

/** A seat whose completion is a decision; everything here is about those and no other step. */
export function isSessionVerdictStep(
  step: SessionChainStep | undefined
): step is SessionChainAgentStep {
  return Boolean(step && step.kind !== 'handoff' && step.verdict)
}

/** One spend per attempt: a replayed tick finds the key already there and changes nothing. */
export function sessionVerdictConsumptionKey(stepId: string, attemptId: string): string {
  return `verdict:${stepId}:${attemptId}`
}

/**
 * WP-2 lowers a gate node's `onFail` onto its compiled seat as a step id
 * (`work-plan-runtime-adapter.ts`: `WorkPlanRuntimeStep = SessionChainAgentStep & { onFail?: string }`),
 * and WP-0.5 persists it. Read structurally so the field has exactly one owner; when a reload has
 * dropped it, the gate blocks instead of routing, which is the fail-closed direction.
 */
export function sessionVerdictFailRoute(step: SessionChainAgentStep): string | undefined {
  const route = (step as { onFail?: unknown }).onFail
  return typeof route === 'string' && route.trim() ? route.trim() : undefined
}

/** The last receipt this seat spent, skips excluded: a skip decided nothing. */
export function lastSessionVerdictReceipt(
  chain: VerdictChain,
  stepId: string
): SessionChainVerdictReceipt | undefined {
  return (chain.verdicts ?? []).findLast((entry) => entry.stepId === stepId && !entry.skipped)
}

/**
 * What a stored receipt decided, read back defensively: the envelope is persisted as it was read
 * (`SessionChainVerdictReceipt.verdict` is `unknown`), so nothing downstream may assume its shape.
 */
export function sessionVerdictOfReceipt(
  receipt: SessionChainVerdictReceipt | undefined
): { status: SessionVerdictStatus; candidateVersion?: string } | null {
  const stored = receipt?.verdict
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return null
  }
  const record = stored as Record<string, unknown>
  const version = typeof record.candidateVersion === 'string' ? record.candidateVersion : undefined
  return SESSION_VERDICT_STATUSES.includes(record.status as SessionVerdictStatus)
    ? {
        status: record.status as SessionVerdictStatus,
        ...(version ? { candidateVersion: version } : {})
      }
    : null
}

/**
 * Persist the receipt BEFORE the verdict is acted on. Why: the act (skipping the losing seats,
 * minting Done When receipts, routing a failure) is not atomic with the tick that read it, so a
 * crash between the two has to leave the spend visible or it happens twice.
 */
export function recordSessionVerdictReceipt(
  chain: SessionChain,
  receipt: SessionChainVerdictReceipt
): { chain: SessionChain; replayed: boolean } {
  const spent = (chain.verdicts ?? []).some(
    (entry) => entry.consumptionKey === receipt.consumptionKey
  )
  return spent
    ? { chain, replayed: true }
    : { chain: { ...chain, verdicts: [...(chain.verdicts ?? []), receipt] }, replayed: false }
}

/**
 * A verdict seat that is closed without running still gets a receipt, so "completed" and "decided"
 * never drift apart: `finishReviewRound` closes the other seats of a passed group, and a
 * select-winner verdict closes the seats its winner did not select.
 */
export function sessionVerdictSkipReceipt(
  step: SessionChainAgentStep,
  attemptId: string | undefined,
  reason: string,
  now: number
): SessionChainVerdictReceipt {
  return {
    stepId: step.id,
    // A seat that never launched has no attempt; the skip is still the record of its closing.
    attemptId: attemptId ?? 'no-attempt',
    verdict: { skipped: reason },
    consumptionKey: `verdict-skip:${step.id}:${attemptId ?? reason}`,
    consumedAt: now,
    skipped: true
  }
}

/**
 * The runtime invariant: `completedSteps ∩ verdictSteps ⊆ verdicts.stepId`. A verdict seat that
 * reached `completedSteps` with no receipt decided nothing, so anything downstream of it is
 * unproven — the tick blocks the outcome with these words instead of letting it pass.
 */
export function verdictInvariantProblems(chain: VerdictChain): string[] {
  const completed = new Set(chain.outcomeSet?.completedSteps ?? [])
  const receipted = new Set((chain.verdicts ?? []).map((entry) => entry.stepId))
  return chain.steps
    .filter(
      (step) => isSessionVerdictStep(step) && completed.has(step.id) && !receipted.has(step.id)
    )
    .map((step) => `Verdict without receipt: ${step.id} completed without deciding anything.`)
}
