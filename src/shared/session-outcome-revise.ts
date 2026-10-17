import { validateSessionOutcomeDefinitions } from './session-outcome-validation'
import { sessionOutcomeIdentity, sessionOutcomeStepActionId } from './session-outcome-identity'
import { reviseSealedSessionOutcomeSet } from './session-run-sealed-revision'
import {
  sessionOutcomeActionKey,
  sessionOutcomeConditionKey,
  type SessionOutcomeCommit,
  type SessionOutcomeSet
} from './session-outcome-types'

export function reconcileSessionOutcomeSet(set: SessionOutcomeSet): SessionOutcomeSet {
  // A sealed run is read exactly as it was proven: later drift is about the world, not this run.
  if (set.completion) {
    return set
  }
  const outcomes = set.outcomes.map((outcome) => {
    const evidence = outcome.evidence.filter(
      (entry) =>
        entry.outcomeId === outcome.id &&
        entry.outcomeRevision === outcome.revision &&
        outcome.conditions.some(
          (condition) =>
            condition.id === entry.conditionId &&
            entry.conditionKey === sessionOutcomeConditionKey(condition) &&
            entry.kind === condition.kind &&
            entry.target === condition.target &&
            (condition.version === undefined || entry.version === condition.version)
        )
    )
    const satisfied =
      (outcome.stepIds ?? []).every((stepId) => set.completedSteps?.includes(stepId)) &&
      outcome.conditions.every((condition) =>
        evidence.some((entry) => entry.conditionId === condition.id)
      ) &&
      outcome.actions.every((action) =>
        set.attempts.some(
          (attempt) =>
            attempt.outcomeId === outcome.id &&
            attempt.actionId === action.id &&
            attempt.actionKey === sessionOutcomeActionKey(action) &&
            attempt.state === 'completed'
        )
      )
    const status = satisfied
      ? ('satisfied' as const)
      : outcome.status === 'satisfied'
        ? ('pending' as const)
        : outcome.status
    if (status === 'blocked') {
      return { ...outcome, evidence, status }
    }
    // A block describes a blocked outcome only; it never outlives the status it explains.
    const { block: _cleared, ...unblocked } = outcome
    return { ...unblocked, evidence, status }
  })
  return { ...set, outcomes }
}

/**
 * Retires the attempts of steps a newer plan version replaced: the ones that never settled are
 * marked `superseded` and their error cleared, because an attempt nobody will finish is not a
 * failure to report. A settled attempt — completed, or already superseded — is left exactly as it is.
 */
function supersedeAttempts(
  attempts: SessionOutcomeSet['attempts'],
  supersededStepIds: readonly string[]
): SessionOutcomeSet['attempts'] {
  if (!supersededStepIds.length) {
    return attempts
  }
  const retired = new Set(supersededStepIds.map(sessionOutcomeStepActionId))
  return attempts.map((attempt) => {
    if (
      !retired.has(attempt.actionId) ||
      !['prepared', 'blocked', 'retryable', 'unverifiable'].includes(attempt.state)
    ) {
      return attempt
    }
    const { error: _error, ...rest } = attempt
    return { ...rest, state: 'superseded' as const }
  })
}

function assertTaskRefMatchesExecution(
  input: SessionOutcomeCommit,
  owner: SessionOutcomeSet['continuation']
): void {
  if (input.taskRef && owner.taskId && owner.taskId !== input.taskRef.taskId) {
    // Why: `continuation.taskId` is the card this conversation EXECUTES; `taskRef` is the card the
    // outcome is filed under. They may both exist, but they may not disagree about which card.
    throw new Error(
      'This work is already executing a different card. Detach it before filing here.'
    )
  }
}

export function reviseSessionOutcomeSet(
  previous: SessionOutcomeSet | undefined,
  input: SessionOutcomeCommit,
  owner: SessionOutcomeSet['continuation'],
  now: number
): SessionOutcomeSet {
  if ((previous?.revision ?? 0) !== input.expectedRevision) {
    throw new Error('Outcome revision conflict. Reload the saved outcomes before editing.')
  }
  validateSessionOutcomeDefinitions(input.outcomes)
  assertTaskRefMatchesExecution(input, owner)
  if (previous?.completion) {
    // A sealed run stays as it was proven; the fork (`forkFinishedOutcomeSource`) is where new work goes.
    return reviseSealedSessionOutcomeSet(previous, input, now)
  }
  const removed =
    previous?.outcomes.filter((old) => !input.outcomes.some((next) => next.id === old.id)) ?? []
  if (removed.length && input.source !== 'user') {
    throw new Error('AI cannot remove committed outcomes.')
  }
  if (
    removed.some(
      (old) =>
        !input.removals?.some((removal) => removal.outcomeId === old.id && removal.reason.trim())
    )
  ) {
    throw new Error('Removing an outcome requires an explicit scope-change reason.')
  }
  if (input.removals?.some((entry) => !removed.some((old) => old.id === entry.outcomeId))) {
    throw new Error('Removal does not match the committed scope change.')
  }
  const inFlight = (outcomeId: string, actionId: string): boolean =>
    previous?.attempts.some(
      (attempt) =>
        attempt.outcomeId === outcomeId &&
        attempt.actionId === actionId &&
        ['launching', 'running', 'unverifiable'].includes(attempt.state)
    ) ?? false
  // Why these ids: a supersede retires what the OLD plan had not finished, so the new version is not
  // blocked by work nobody will do — and nothing is erased, the steps and their attempts stay
  // addressable under their own plan version. Except what the new plan STILL DRAWS: a version that
  // only dropped one stage keeps the ones beside it, and retiring those would complete a step that
  // never ran and take it off the panel (`drawsSteps`).
  const drawn = new Set(input.supersede ? (input.drawsSteps ?? []) : [])
  const superseded = input.supersede
    ? (previous?.outcomes ?? []).flatMap((old) =>
        (old.stepIds ?? []).filter(
          (stepId) => !previous?.completedSteps?.includes(stepId) && !drawn.has(stepId)
        )
      )
    : []
  const revision = (previous?.revision ?? 0) + 1
  const outcomes = input.outcomes.map((definition) => {
    const old = previous?.outcomes.find((entry) => entry.id === definition.id)
    if (
      old &&
      definition.actions.some((action) =>
        previous?.attempts.some(
          (attempt) =>
            attempt.outcomeId === old.id &&
            attempt.actionId === action.id &&
            attempt.state === 'completed' &&
            attempt.actionKey !== sessionOutcomeActionKey(action)
        )
      )
    ) {
      throw new Error('A completed action cannot be rewritten. Add a new action ID for new work.')
    }
    // Why IDENTITY and not the whole definition: a new plan for the same outcome is not a new
    // outcome. Comparing `stepIds`/`actions`/`finish` made every re-plan — and every change of mind
    // about who reads the result — bump the revision, which re-stamped every receipt and spent every
    // review receipt: the work read as unproven because the route to it changed. What the outcome IS
    // decides that; how it is pursued, and who receives it, does not.
    const changed =
      !old ||
      JSON.stringify(sessionOutcomeIdentity(old)) !==
        JSON.stringify(sessionOutcomeIdentity(definition))
    if (
      old &&
      changed &&
      previous?.attempts.some(
        (attempt) =>
          attempt.outcomeId === old.id &&
          ['launching', 'running', 'unverifiable'].includes(attempt.state)
      )
    ) {
      throw new Error(
        'This outcome has an in-flight or unverifiable action. Reconcile its receipt before editing.'
      )
    }
    // Why also per step: a plan may be rewritten AROUND work that is running, never THROUGH it. The
    // identity guard above no longer sees a plan-only edit, so the step this plan drops — or the
    // action it rewrites — must not be one the host is executing right now.
    if (
      old &&
      ((old.stepIds ?? [])
        .filter((stepId) => !(definition.stepIds ?? []).includes(stepId))
        .some((stepId) => inFlight(old.id, sessionOutcomeStepActionId(stepId))) ||
        definition.actions.some(
          (action) =>
            inFlight(old.id, action.id) &&
            old.actions.some(
              (entry) =>
                entry.id === action.id &&
                sessionOutcomeActionKey(entry) !== sessionOutcomeActionKey(action)
            )
        ))
    ) {
      throw new Error(
        'This outcome has an in-flight or unverifiable action. Reconcile its receipt before editing.'
      )
    }
    const outcomeRevision = old ? old.revision + Number(changed) : 1
    // A new acceptance revision needs new proof; never re-stamp the previous requirement's receipt.
    const retainedEvidence = (changed ? [] : (old?.evidence ?? [])).filter((entry) =>
      definition.conditions.some(
        (condition) =>
          condition.id === entry.conditionId &&
          sessionOutcomeConditionKey(condition) === entry.conditionKey
      )
    )
    // Why carried and not committed: filing an outcome under a card is not a change to the outcome.
    // It rides on the runtime record, outside the definition, so it bumps nothing and spends nothing.
    const taskRef = input.taskRef ?? old?.taskRef
    // A wait's last reading (and the owner's re-arm) stays with a condition that did not change.
    const waits = (old?.waits ?? []).filter((fact) => {
      const before = old!.conditions.find((condition) => condition.id === fact.conditionId)
      const after = definition.conditions.find((condition) => condition.id === fact.conditionId)
      return (
        before && after && sessionOutcomeConditionKey(before) === sessionOutcomeConditionKey(after)
      )
    })
    return {
      ...structuredClone(definition),
      revision: outcomeRevision,
      // Why pending on supersede: the old plan's block was about a route this version abandoned.
      status: input.supersede || changed ? ('pending' as const) : old!.status,
      evidence: retainedEvidence,
      ...(taskRef ? { taskRef: structuredClone(taskRef) } : {}),
      ...(waits.length ? { waits: structuredClone(waits) } : {}),
      ...(!input.supersede && !changed && old?.blockedReason
        ? { blockedReason: old.blockedReason }
        : {}),
      // The class rides with the reason: a carried block that lost it would read as unclassified.
      ...(!input.supersede && !changed && old?.block ? { block: structuredClone(old.block) } : {})
    }
  })
  if (
    removed.some((old) =>
      previous?.attempts.some(
        (attempt) =>
          attempt.outcomeId === old.id &&
          ['launching', 'running', 'unverifiable'].includes(attempt.state)
      )
    )
  ) {
    throw new Error('Reconcile in-flight work before removing its outcome.')
  }
  // Retain action receipts across edits and removals; changing the label must not resend a delivery.
  return reconcileSessionOutcomeSet({
    schemaVersion: 1,
    // A commit that leaves the finish out keeps the one the set had; taking Done back off the
    // chain is the one commit that says so, and only that clears it.
    ...(input.clearSessionFinish || !(input.sessionFinish ?? previous?.sessionFinish)
      ? {}
      : { sessionFinish: structuredClone(input.sessionFinish ?? previous!.sessionFinish!) }),
    revision,
    outcomes,
    removals: [
      ...(previous?.removals ?? []),
      ...removed.map((old) => ({
        outcomeId: old.id,
        revision,
        reason: input.removals!.find((entry) => entry.outcomeId === old.id)!.reason,
        removedAt: now
      }))
    ],
    attempts: supersedeAttempts(structuredClone(previous?.attempts ?? []), superseded),
    ...(previous?.publications ? { publications: structuredClone(previous.publications) } : {}),
    completedSteps: [...new Set([...(previous?.completedSteps ?? []), ...superseded])],
    evidenceHistory: structuredClone([
      ...(previous?.evidenceHistory ?? []),
      ...(previous?.outcomes ?? []).flatMap((old) =>
        old.evidence.filter(
          (entry) =>
            !outcomes.some((outcome) => outcome.evidence.some((kept) => kept.id === entry.id)) &&
            !previous?.evidenceHistory?.some((historical) => historical.id === entry.id)
        )
      )
    ]),
    // Requests ride along; the host's next pass withdraws the ones this revision made stale.
    ...(previous?.attention ? { attention: structuredClone(previous.attention) } : {}),
    continuation: owner,
    updatedAt: now
  })
}
