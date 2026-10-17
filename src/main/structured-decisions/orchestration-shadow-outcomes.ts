import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { SESSION_ATTEMPT_FAILURE_CODES } from '../../shared/session-attempt-recovery'
import type { OrchestrationShadowEmit } from './orchestration-shadow'
import {
  OrchestrationShadowScan,
  shadowFieldEqual,
  shadowIdentity,
  shadowReference
} from './orchestration-shadow-bounds'
import { observeHandoffShadowChanges } from './orchestration-shadow-handoffs'
import { countOrchestrationShadow as count } from './orchestration-shadow-measurement'

const ROUTES = {
  'same-session': 'A delivered turn of the original conversation is recorded.',
  native: 'A native continuation with its dispatch receipt is recorded.',
  task: 'A continuation task with its dispatch receipt is recorded.',
  worker: 'A new worker dispatch receipt is recorded.',
  unknown: 'No recorded execution route can be established.'
}
const BLOCKS = {
  recovering: 'The host has an automatic recovery to perform.',
  waiting: 'The work is waiting for an existing wake or evidence poll.',
  attention: 'A recorded human attention requirement prevents progress.',
  failed: 'No safe automatic recovery or recorded wake remains.',
  unknown: 'The structural evidence cannot establish the failure class.'
}
const FAILURES = Object.fromEntries(
  SESSION_ATTEMPT_FAILURE_CODES.map((code) => [code, `Evidence establishes ${code}.`])
)

function route(attempt: SessionOutcomeAttempt): keyof typeof ROUTES | null {
  if (attempt.conversationTurn?.deliveredAt !== undefined) {
    return 'same-session'
  }
  if (!attempt.dispatchId) {
    return null
  }
  if (attempt.nativeContinuation) {
    return 'native'
  }
  return attempt.continuationTaskId ? 'task' : 'worker'
}

function observeAttempts(
  previous: SessionChain,
  saved: SessionChain,
  emit: OrchestrationShadowEmit,
  scan: OrchestrationShadowScan
): void {
  const priorSample = scan.tail(previous.outcomeSet?.attempts)
  const prior = new Map(
    priorSample.values
      .filter((attempt) => shadowIdentity(attempt.id))
      .map((attempt) => [attempt.id, attempt])
  )
  const current = scan.tail(saved.outcomeSet!.attempts)
  for (const [index, attempt] of current.values.entries()) {
    if (!shadowIdentity(attempt.id)) {
      continue
    }
    const old = prior.get(attempt.id)
    if (!old && !priorSample.complete && current.start + index < priorSample.total) {
      count('ambiguousBaselineSkipped')
      continue
    }
    const selected = route(attempt)
    if (selected && (!old || selected !== route(old))) {
      emit({
        kind: 'routing',
        reference: shadowReference(saved.id, attempt.id, 'route'),
        observed: selected,
        choices: ROUTES,
        facts: {
          sameConversationDelivered: attempt.conversationTurn?.deliveredAt !== undefined,
          nativeContinuationRecorded: Boolean(attempt.nativeContinuation),
          continuationTaskRecorded: Boolean(attempt.continuationTaskId),
          dispatchRecorded: Boolean(attempt.dispatchId),
          planVersion: attempt.planVersion ?? 1
        }
      })
    }
    if (
      attempt.failure &&
      shadowIdentity(attempt.failure.code) &&
      Object.hasOwn(FAILURES, attempt.failure.code) &&
      (old?.failure?.code !== attempt.failure.code || old.failure.at !== attempt.failure.at)
    ) {
      emit({
        kind: 'error_classification',
        reference: shadowReference(saved.id, attempt.id, 'failure', attempt.failure.at),
        observed: attempt.failure.code,
        choices: FAILURES,
        facts: {
          source: 'attempt',
          dispatchRecorded: Boolean(attempt.dispatchId),
          launchStarted: attempt.launchDisposition === 'started',
          launchNotStarted: attempt.launchDisposition === 'not-started',
          contactUnverifiable: attempt.state === 'unverifiable',
          awaitingHumanInput: Boolean(attempt.awaiting),
          machineDetailPresent: Boolean(attempt.failure.detail),
          diagnosticTextIncluded: false
        }
      })
    }
  }
}

function conditionFacts(
  outcome: SessionOutcome,
  chain: SessionChain,
  scan: OrchestrationShadowScan
) {
  const conditions = scan.tail(outcome.conditions)
  const evidence = scan.tail(outcome.evidence)
  const attempts = scan.tail(chain.outcomeSet!.attempts)
  const evidenceComplete =
    conditions.complete &&
    evidence.complete &&
    conditions.values.every((condition) => shadowIdentity(condition.id)) &&
    evidence.values.every((entry) => shadowIdentity(entry.conditionId))
  return {
    requiredConditionCount: conditions.total,
    provenConditionCount: evidenceComplete
      ? conditions.values.filter((condition) =>
          evidence.values.some(
            (entry) =>
              entry.conditionId === condition.id && entry.outcomeRevision === outcome.revision
          )
        ).length
      : null,
    activeAttemptCount: attempts.complete
      ? attempts.values.filter(
          (attempt) =>
            shadowFieldEqual(attempt.outcomeId, outcome.id) &&
            ['prepared', 'launching', 'running'].includes(attempt.state)
        ).length
      : null,
    evidenceComplete,
    attemptPopulationComplete: attempts.complete,
    blockPresent: Boolean(outcome.block),
    attentionRequirementCount: outcome.block?.attentionIds?.length ?? 0,
    outcomeRevision: outcome.revision
  }
}

function evidenceChanged(
  old: SessionOutcome | undefined,
  outcome: SessionOutcome,
  scan: OrchestrationShadowScan
): boolean {
  if (!old || old.revision !== outcome.revision || old.status !== outcome.status) {
    return true
  }
  const beforeConditions = scan.tail(old.conditions),
    afterConditions = scan.tail(outcome.conditions)
  const beforeEvidence = scan.tail(old.evidence),
    afterEvidence = scan.tail(outcome.evidence)
  if (
    beforeConditions.total !== afterConditions.total ||
    beforeEvidence.total !== afterEvidence.total
  ) {
    return true
  }
  if (
    beforeConditions.values.length !== afterConditions.values.length ||
    beforeEvidence.values.length !== afterEvidence.values.length
  ) {
    return true
  }
  return (
    afterConditions.values.some((entry, index) => {
      const prior = beforeConditions.values[index]!
      return !shadowFieldEqual(entry.id, prior.id) || entry.kind !== prior.kind
    }) ||
    afterEvidence.values.some((entry, index) => {
      const prior = beforeEvidence.values[index]!
      return (
        !shadowFieldEqual(entry.id, prior.id) ||
        !shadowFieldEqual(entry.conditionId, prior.conditionId) ||
        !shadowFieldEqual(entry.version, prior.version) ||
        entry.outcomeRevision !== prior.outcomeRevision
      )
    })
  )
}

function observeConditions(
  previous: SessionChain,
  saved: SessionChain,
  emit: OrchestrationShadowEmit,
  scan: OrchestrationShadowScan
): void {
  const priorSample = scan.tail(previous.outcomeSet?.outcomes)
  const prior = new Map(
    priorSample.values
      .filter((outcome) => shadowIdentity(outcome.id))
      .map((outcome) => [outcome.id, outcome])
  )
  const current = scan.tail(saved.outcomeSet!.outcomes)
  for (const [index, outcome] of current.values.entries()) {
    if (!shadowIdentity(outcome.id)) {
      continue
    }
    const old = prior.get(outcome.id)
    if (!old && !priorSample.complete && current.start + index < priorSample.total) {
      count('ambiguousBaselineSkipped')
      continue
    }
    if (evidenceChanged(old, outcome, scan)) {
      emit({
        kind: 'done_when',
        reference: shadowReference(saved.id, outcome.id, saved.outcomeSet!.revision, 'conditions'),
        observed: outcome.status,
        choices: {
          satisfied:
            'Every requirement has current execution-host evidence and no unresolved block.',
          pending: 'Requirements remain unproven and no attempt is currently running.',
          running: 'An active attempt is still pursuing unproven requirements.',
          blocked: 'A recorded block prevents requirements from being fulfilled.',
          unknown:
            'Incomplete structural evidence cannot establish the outcome state; null counts are unknown.'
        },
        facts: conditionFacts(outcome, saved, scan)
      })
    }
    if (
      outcome.block &&
      shadowIdentity(outcome.block.class) &&
      Object.hasOwn(BLOCKS, outcome.block.class) &&
      (old?.block?.class !== outcome.block.class ||
        !shadowFieldEqual(old.block.code, outcome.block.code))
    ) {
      emit({
        kind: 'error_classification',
        reference: shadowReference(saved.id, outcome.id, 'block', outcome.block.since),
        observed: outcome.block.class,
        choices: BLOCKS,
        facts: {
          source: 'outcome-block',
          automaticRetryScheduled: outcome.block.until !== undefined,
          wakeRecorded: Boolean(outcome.block.wake),
          attentionRequirementCount: outcome.block.attentionIds?.length ?? 0,
          diagnosticTextIncluded: false
        }
      })
    }
  }
}

export function observeOutcomeShadowChanges(
  previous: SessionChain,
  saved: SessionChain,
  emit: OrchestrationShadowEmit,
  scan = new OrchestrationShadowScan()
): void {
  observeAttempts(previous, saved, emit, scan)
  observeConditions(previous, saved, emit, scan)
  observeHandoffShadowChanges(previous, saved, emit, scan)
}
