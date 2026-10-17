import type { HumanAttentionRequest } from './session-human-attention'
import type { SessionOutcomeBlock } from './session-outcome-block'
import { recordSessionOutcomeEvidence, reviseSessionOutcomeSet } from './session-outcome-state'
import {
  sessionOutcomeConditionKey,
  type SessionOutcomeAttempt,
  type SessionOutcomeDefinition,
  type SessionOutcomeEvidence,
  type SessionOutcomeSet
} from './session-outcome-types'

/** Committed sets for the run-lifecycle tests: built through the real commit, never by hand. */
export const RUN_OWNER = {
  owner: 'execution-host',
  hostId: 'local',
  epoch: 'host1',
  state: 'owned'
} as const

export function runDefinition(
  id: string,
  extra: Partial<SessionOutcomeDefinition> = {}
): SessionOutcomeDefinition {
  return {
    id,
    title: id,
    finish: 'complete',
    dependsOn: [],
    conditions: [{ id: 'file', kind: 'file', target: `/output/${id}`, version: 'a'.repeat(64) }],
    actions: [],
    ...extra
  }
}

export function runSet(outcomes = [runDefinition('one')]): SessionOutcomeSet {
  return reviseSessionOutcomeSet(
    undefined,
    { expectedRevision: 0, outcomes, source: 'user' },
    RUN_OWNER,
    1
  )
}

export function runEvidence(set: SessionOutcomeSet, outcomeId: string): SessionOutcomeEvidence {
  const outcome = set.outcomes.find((entry) => entry.id === outcomeId)!
  const condition = outcome.conditions[0]!
  return {
    id: `receipt_${outcomeId}`,
    outcomeId,
    outcomeRevision: outcome.revision,
    conditionId: condition.id,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    version: condition.version,
    receipt: `sha256:${condition.version}`,
    verifiedAt: 2,
    verifier: 'execution-host'
  }
}

/** Records the receipt that proves each named outcome. */
export function proveRun(set: SessionOutcomeSet, ...outcomeIds: string[]): SessionOutcomeSet {
  return outcomeIds.reduce(
    (next, outcomeId) => recordSessionOutcomeEvidence(next, runEvidence(next, outcomeId)),
    set
  )
}

/** One outcome blocked the way a writer leaves it; without `block` it is the legacy, unclassified shape. */
export function blockRunOutcome(
  set: SessionOutcomeSet,
  outcomeId: string,
  blockedReason: string,
  block?: SessionOutcomeBlock
): SessionOutcomeSet {
  return {
    ...set,
    outcomes: set.outcomes.map((outcome) =>
      outcome.id === outcomeId
        ? { ...outcome, status: 'blocked' as const, blockedReason, ...(block ? { block } : {}) }
        : outcome
    )
  }
}

export function runAttempt(extra: Partial<SessionOutcomeAttempt> = {}): SessionOutcomeAttempt {
  return {
    id: 'att_1',
    outcomeId: 'one',
    actionId: 'step_s1',
    actionKey: 'step_s1',
    outcomeRevision: 1,
    state: 'running',
    startedAt: 1,
    updatedAt: 1,
    ...extra
  }
}

export function runScope(
  extra: Partial<HumanAttentionRequest['scope']> = {}
): HumanAttentionRequest['scope'] {
  return { outcomeId: 'one', outcomeRevision: 1, ...extra }
}
