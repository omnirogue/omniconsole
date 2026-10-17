import type { OrcaRuntimeService } from './omni-runtime'
import {
  sessionOutcomeHandoffBlocker,
  sessionOutcomeHandoffNeedsSignIn
} from './session-outcome-handoff'
import { SESSION_OUTCOME_HANDOFF_SIGN_IN } from './session-outcome-handoff-recovery'
import { verifySessionOutcomeProgress } from './session-outcome-verification'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  openHumanAttention,
  reconcileHumanAttention,
  type HumanAttentionDraft
} from '../../shared/session-human-attention'
import { sessionOutcomeBlock } from '../../shared/session-outcome-block'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import {
  sessionOutcomeAttemptBlock,
  type SessionAttemptBlockReading
} from './session-outcome-attempt-block'
import { isContinuationBlocked } from './session-outcome-continuation-block'
import { sessionOutcomeGateHold } from './session-outcome-gate-hold'
import { observeSessionOutcomeSource, type SourceObservation } from './session-outcome-source'
import { sessionOutcomeHoldBlock, type SessionOutcomeHold } from './session-outcome-hold-block'
import {
  sessionOutcomeBarrierStep,
  sessionOutcomeReviewPlanHold
} from './session-outcome-review-plan-hold'

/**
 * THE place an outcome's `{status, blockedReason, block}` is derived, every pass
 * (`docs/reference/session-run-lifecycle.md`): from its attempts through the recovery ladder, from
 * a live agent's own question, from a gate that said no with nowhere to route it, a held handoff, a
 * review round that stopped or cannot run as planned, or a finished outcome whose proof is not
 * there yet. It opens the requests those readings ask of a person and ends by
 * reconciling every request against what is still asked, so a met requirement closes by itself.
 * A satisfied outcome and a sealed set are never touched. Takes chain/runtime as arguments rather
 * than importing the caller back, to avoid an import cycle with session-outcome-tick.ts.
 *
 * @param stagedStepIds steps that completed in this tick: their outcome is verified now, so k/n
 * Done When rises stage by stage instead of only when the whole outcome is finished.
 */
export async function recomputeSessionOutcomeStatuses(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  initialSet: SessionOutcomeSet,
  stagedStepIds: readonly string[] = [],
  now = Date.now()
): Promise<SessionOutcomeSet> {
  if (initialSet.completion) {
    return initialSet
  }
  let set = initialSet
  // A superseded plan version's work is history: it never blocks the version running now.
  const planVersion = chain.planVersion ?? 1
  const current = (record: { planVersion?: number } | undefined): boolean =>
    (record?.planVersion ?? 1) >= planVersion
  // Requests still asked for after this pass; every other open one was met, and is resolved.
  const keep = new Set<string>()
  // One reading of the source conversation per pass, taken only when an outcome needs it.
  let sourceNow: Promise<SourceObservation> | undefined
  const sourceMidTurn = async (): Promise<boolean> => {
    sourceNow ??= observeSessionOutcomeSource(runtime, chain)
    const source = await sourceNow
    return !source.ready && !source.unverifiable
  }
  const open = (drafts: readonly HumanAttentionDraft[]): string[] =>
    drafts.flatMap((draft) => {
      try {
        const opened = openHumanAttention(set, draft, now)
        set = opened.set
        keep.add(opened.id)
        return [opened.id]
      } catch (error) {
        // A request the schema refuses must not cost the pass: the block still says why.
        console.warn('[outcomes] could not open an attention request', chain.id, error)
        return []
      }
    })
  for (const outcome of set.outcomes) {
    if (
      outcome.status === 'satisfied' ||
      // The tick owns these and lifts them itself; rewriting one here would restart its clock.
      isContinuationBlocked(outcome) ||
      !outcome.dependsOn.every(
        (id) => set.outcomes.find((entry) => entry.id === id)?.status === 'satisfied'
      )
    ) {
      outcome.block?.attentionIds?.forEach((id) => keep.add(id))
      continue
    }
    const attempts = set.attempts.filter((entry) => entry.outcomeId === outcome.id)
    const pendingAction = attempts.some((entry) =>
      ['launching', 'running', 'unverifiable', 'prepared'].includes(entry.state)
    )
    const reviewGroup = (outcome.stepIds ?? []).flatMap((id) => {
      const step = chain.steps.find((entry) => entry.id === id)
      return step?.kind !== 'handoff' &&
        step?.review &&
        current(step) &&
        chain.reviewLoop?.groups.some(
          (group) => group.id === step.review!.groupId && group.status === 'blocked'
        )
        ? [step.review.groupId]
        : []
    })[0]
    const barrier = sessionOutcomeBarrierStep({ ...chain, outcomeSet: set }, outcome)
    const handoffHeld =
      (outcome.stepIds ?? [])
        .map((id) => chain.steps.find((entry) => entry.id === id))
        // A handoff seat carries no plan version (it is a rule, not a launch): a superseded one is
        // entered into `completedSteps` by the supersede commit, which is what excludes it here.
        .flatMap((step) => {
          const reason =
            step?.kind === 'handoff' && !set.completedSteps?.includes(step.id)
              ? sessionOutcomeHandoffBlocker(step, now)
              : undefined
          return reason ? [{ kind: 'handoff' as const, stepId: step!.id, reason }] : []
        })[0] ??
      // Only the handoff that is next: a missing sign-in must not stop the stages before it.
      (barrier?.kind === 'handoff' &&
      sessionOutcomeHandoffNeedsSignIn({ ...chain, outcomeSet: set })
        ? { kind: 'handoff' as const, stepId: barrier.id, reason: SESSION_OUTCOME_HANDOFF_SIGN_IN }
        : undefined)
    let held: SessionAttemptBlockReading | null = sessionOutcomeAttemptBlock(
      runtime,
      chain,
      set,
      outcome,
      now
    )
    // Re-derived from the record on every pass, so each of these stays in place (and keeps its
    // `since`) for as long as its cause does, and a hold that asks a person keeps its one request.
    let hold: SessionOutcomeHold | undefined =
      sessionOutcomeGateHold(chain, set, outcome) ??
      handoffHeld ??
      (reviewGroup && outcome.blockedReason
        ? { kind: 'review-round', groupId: reviewGroup, reason: outcome.blockedReason }
        : undefined) ??
      (await sessionOutcomeReviewPlanHold({ ...chain, outcomeSet: set }, outcome))
    const actionsCompleted = outcome.actions.every((action) =>
      attempts.some((entry) => entry.actionId === action.id && entry.state === 'completed')
    )
    const stepsCompleted = (outcome.stepIds ?? []).every((id) => set.completedSteps?.includes(id))
    const finished = !pendingAction && actionsCompleted && stepsCompleted
    const staged = stagedStepIds.some((id) => (outcome.stepIds ?? []).includes(id))
    // An outcome with nothing of its own to run is finished by the source conversation's work,
    // so its "result" exists only once that conversation is idle NOW. `continuation.sourceReady`
    // is sticky (the pane was idle once); a person who sent the agent back to work would
    // otherwise be asked to review a result that is still being produced — and asked while the
    // sidebar shows the same conversation working. The verifier still runs (a contrary reading
    // retires the stale session receipt at once); only its reason is not a hold yet.
    const sourceIsTheWork = outcome.actions.length === 0 && !(outcome.stepIds ?? []).length
    const sourceStillWorking = finished && sourceIsTheWork && (await sourceMidTurn())
    if (
      set.continuation.sourceReady &&
      set.outcomes.find((entry) => entry.id === outcome.id)?.status !== 'satisfied' &&
      (finished || staged || outcome.evidence.length > 0)
    ) {
      const verified = await verifySessionOutcomeProgress(
        runtime,
        { ...chain, outcomeSet: set },
        outcome,
        false,
        now
      )
      // Mid-flight verification only ADDS receipts: proof an unfinished outcome does not have yet
      // is not a blocker but the work still running, and a mid-run read that failed (a detached
      // volume, a file being rewritten) must not spend the receipts its earlier stages earned.
      const lost = outcome.evidence.some(
        (prior) =>
          !verified.set.outcomes
            .find((entry) => entry.id === outcome.id)
            ?.evidence.some((entry) => entry.id === prior.id)
      )
      if (finished) {
        set = verified.set
        if (verified.reason && !sourceStillWorking) {
          hold ??= { kind: 'verification', reason: verified.reason }
        }
      } else if (!lost) {
        set = verified.set
      }
    }
    const live = set.outcomes.find((entry) => entry.id === outcome.id)!
    if (!held && hold) {
      const reading = sessionOutcomeHoldBlock(chain, set, live, hold, now)
      held = {
        reason: hold.reason.trim() || 'This outcome is held.',
        block: reading.block,
        attention: reading.attention
      }
    }
    // Opened before the block is written, so the block names the requests that explain it.
    const attentionIds = held ? open(held.attention) : []
    set = {
      ...set,
      outcomes: set.outcomes.map((entry) => {
        if (entry.id !== outcome.id || entry.status === 'satisfied') {
          return entry
        }
        if (!held) {
          return {
            ...entry,
            status: pendingAction ? 'running' : 'pending',
            blockedReason: undefined,
            block: undefined
          }
        }
        return {
          ...entry,
          status: 'blocked',
          blockedReason: held.reason,
          block: sessionOutcomeBlock(
            { ...held.block, ...(attentionIds.length ? { attentionIds } : {}) },
            entry.block,
            now
          )
        }
      })
    }
  }
  return reconcileHumanAttention(set, keep, now, planVersion)
}
