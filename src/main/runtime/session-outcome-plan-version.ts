import { sessionOutcomeStepSignature } from './session-outcome-revision'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeDefinitionSchema,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'
import { markSteps, type OutcomeStepAccess } from './session-outcome-step-progress'

/**
 * The definitions this commit submits, spelled the way the SCHEMA spells them.
 *
 * `reviseSessionOutcomeSet` decides "is this still the same outcome?" by comparing the stored copy
 * with the submitted one AS JSON, and the stored copy came back through this schema
 * (`normalizeSessionChain`), which rebuilds every object in its own key order. A freshly lowered
 * condition carries the lowering's order instead: `{id, label, kind, target}` and
 * `{id, kind, label, target}` are the same condition written two ways, and the comparison called
 * them different. So EVERY second commit on a pursuit read as a CHANGED Outcome — the revision
 * bumped, every human-review receipt was discarded, the status reset to pending, and while a seat
 * was running the commit was refused outright ("This outcome has an in-flight or unverifiable
 * action"), which is what a second ＋ Agent behind a running stage hit (LS-2). Normalised at the
 * one door every commit passes through, so the comparison is about what the outcome IS again.
 */
function canonicalOutcomeCommit(input: SessionOutcomeCommit): SessionOutcomeCommit {
  return {
    ...input,
    outcomes: input.outcomes.map((outcome) => sessionOutcomeDefinitionSchema.parse(outcome))
  }
}

/**
 * The plan version this commit declares, and the definitions it submits in their canonical
 * spelling — the two things every commit has to settle about its own input before the reviser
 * compares it with what the chain already holds.
 */
export function prepareOutcomePlanVersion(
  base: SessionChain,
  old: SessionChain | undefined,
  input: SessionOutcomeCommit
): { base: SessionChain; input: SessionOutcomeCommit } {
  input = canonicalOutcomeCommit(input)
  const version = old?.planVersion ?? 1
  const submitted = input.planVersion ?? base.planVersion
  if (!input.supersede) {
    if (submitted !== undefined && submitted !== version) {
      throw new Error('A new plan version requires supersede with a reason.')
    }
    return {
      base: {
        ...base,
        steps: base.steps.map((step) => ({
          ...step,
          planVersion: old?.steps.find((prior) => prior.id === step.id)?.planVersion ?? version
        }))
      },
      input
    }
  }
  if (!old?.outcomeSet || !input.supersede.reason.trim()) {
    throw new Error('Supersede requires a committed plan and a reason.')
  }
  if (submitted !== undefined && submitted !== version + 1) {
    throw new Error('Plan version conflict. Reload the saved plan before superseding.')
  }
  if (
    old.outcomeSet.attempts.some(
      (attempt) =>
        old.steps.some((step) => attempt.actionId === `step_${step.id}`) &&
        ['launching', 'running', 'unverifiable'].includes(attempt.state)
    )
  ) {
    throw new Error('This step may already be in progress. Resolve it before superseding it.')
  }
  const priorIds = new Set(old.steps.map((step) => step.id))
  for (const step of base.steps) {
    const prior = old.steps.find((entry) => entry.id === step.id)
    if (prior && sessionOutcomeStepSignature(prior) !== sessionOutcomeStepSignature(step)) {
      throw new Error('A superseding plan must use new identities for changed steps.')
    }
  }
  const newSteps = base.steps.filter((step) => !priorIds.has(step.id))
  if (
    old.outcomeSet.outcomes.some(
      (outcome) => !input.outcomes.some((next) => next.id === outcome.id)
    )
  ) {
    throw new Error('Supersede must retain the existing Outcome identities.')
  }
  return {
    base: {
      ...base,
      planVersion: version + 1,
      planVersions: [
        ...(old.planVersions ?? [{ version, at: old.createdAt }]),
        {
          version: version + 1,
          supersedes: version,
          reason: input.supersede.reason,
          at: Date.now()
        }
      ],
      steps: [...old.steps, ...newSteps.map((step) => ({ ...step, planVersion: version + 1 }))]
    },
    input: {
      ...input,
      outcomes: input.outcomes.map((outcome) => ({
        ...outcome,
        stepIds: [
          ...new Set([
            ...(old.outcomeSet!.outcomes.find((entry) => entry.id === outcome.id)?.stepIds ?? []),
            ...(outcome.stepIds ?? [])
          ])
        ]
      }))
    }
  }
}

/**
 * Retires the steps the OLD plan left unfinished and the new one no longer draws.
 *
 * `draws` is the new plan's own list of what it kept (`SessionOutcomeCommit.drawsSteps`). Absent
 * means the caller could not say, and everything unfinished is retired — which is what a change
 * of strategy has always done. A drawn step is left exactly as it stands: it is queued work of
 * the current version, not a leftover.
 */
export function markSupersededPlanSteps(
  chain: SessionChain,
  old: SessionChain,
  draws?: readonly string[]
): SessionChain {
  const drawn = new Set(draws ?? [])
  const ids = old.steps
    .filter((step) => !old.outcomeSet?.completedSteps?.includes(step.id) && !drawn.has(step.id))
    .map((step) => step.id)
  let next = chain
  markSteps(
    {
      read: () => next,
      save: (value) => {
        next = value
      }
    } as OutcomeStepAccess,
    ids,
    true
  )
  return {
    ...next,
    steps: next.steps.map((step) => {
      const prior = old.steps.find((entry) => entry.id === step.id)
      if (!prior) {
        return step
      }
      // A step this version DRAWS belongs to it: every reader of a chain — the panel, the
      // barrier, the team summary, the plan view — reads the current version's steps, so one
      // left stamped with the version it was first committed under is work that will run and
      // is shown nowhere. Its id, status, prompts and receipts are untouched; which plan draws
      // it is exactly what `planVersion` records. Stamped here rather than before the reconcile,
      // which restores an unchanged step from the old record verbatim.
      if (drawn.has(step.id)) {
        return step.planVersion === chain.planVersion
          ? step
          : { ...step, planVersion: chain.planVersion }
      }
      if (!ids.includes(step.id)) {
        return step
      }
      if (
        prior.status === 'failed' ||
        prior.status === 'launched' ||
        prior.status === 'delivered'
      ) {
        return prior
      }
      return { ...step, status: 'skipped', supersededBy: chain.planVersion }
    })
  }
}
