import { SESSION_RECOVERY_MAX_AUTO_RETRIES } from '../../shared/session-attempt-recovery'
import type { SessionChain } from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeCondition,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'
import {
  sessionOutcomeDeliverableRepairStore,
  type SessionOutcomeDeliverableRepair,
  type SessionOutcomeDeliverableRepairKey
} from './session-outcome-deliverable-repair-store'
import type { SessionOutcomeHoldReading } from './session-outcome-hold-block'

export const SESSION_OUTCOME_DELIVERABLE_REPAIR_CODE = 'deliverable-repair'
/** The bound is the recovery ladder's, counted per outcome revision and plan version. */
export const SESSION_OUTCOME_DELIVERABLE_REPAIRS_MAX = SESSION_RECOVERY_MAX_AUTO_RETRIES

export function sessionOutcomeDeliverableRepairKey(
  chain: SessionChain,
  outcome: SessionOutcome
): SessionOutcomeDeliverableRepairKey {
  return {
    chainId: chain.id,
    outcomeId: outcome.id,
    outcomeRevision: outcome.revision,
    planVersion: chain.planVersion ?? 1
  }
}

/** The file conditions this outcome's current revision holds no receipt for. */
export function unprovenSessionOutcomeFiles(outcome: SessionOutcome): SessionOutcomeCondition[] {
  const proven = new Set(
    outcome.evidence
      .filter((entry) => entry.outcomeRevision === outcome.revision)
      .map((entry) => entry.conditionId)
  )
  return outcome.conditions.filter(
    (condition) => condition.kind === 'file' && !proven.has(condition.id)
  )
}

/** Sent, and the turn that answers it has not ended yet. */
export function openSessionOutcomeDeliverableRepair(
  records: readonly SessionOutcomeDeliverableRepair[]
): SessionOutcomeDeliverableRepair | undefined {
  return records.find(
    (record) =>
      record.promptId && !record.failed && !record.unrepairable && record.settledAt === undefined
  )
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value))
}

/**
 * What a finished outcome whose promised file is missing is while its agent may still write it:
 * `recovering` until a repair goes to the run's own conversation, `waiting` on the turn that
 * answers it. Null means no repair is left — budget spent, a repair turn that changed nothing, a
 * conversation that is gone, or a host without the record — and the outcome fails as before.
 */
export function sessionOutcomeDeliverableRepairHold(
  chain: SessionChain,
  set: SessionOutcomeSet,
  outcome: SessionOutcome
): SessionOutcomeHoldReading | null {
  const store = sessionOutcomeDeliverableRepairStore()
  // A workflow run re-verifies only when a stage lands, so a repair turn there would never be read.
  if (!store || set.workflow) {
    return null
  }
  const records = store.list(sessionOutcomeDeliverableRepairKey(chain, outcome))
  if (records.some((record) => record.unrepairable)) {
    return null
  }
  if (openSessionOutcomeDeliverableRepair(records)) {
    return {
      block: {
        class: 'waiting',
        code: SESSION_OUTCOME_DELIVERABLE_REPAIR_CODE,
        wake: 'repair turn'
      },
      attention: []
    }
  }
  if (records.length >= SESSION_OUTCOME_DELIVERABLE_REPAIRS_MAX) {
    return null
  }
  const last = records.at(-1)
  const missing = unprovenSessionOutcomeFiles(outcome).map((condition) => condition.id)
  // A repair turn that left exactly the same files missing made no progress; another would not.
  if (last?.settledAt !== undefined && sameIds(last.conditionIds, missing)) {
    return null
  }
  return {
    block: { class: 'recovering', code: SESSION_OUTCOME_DELIVERABLE_REPAIR_CODE },
    attention: []
  }
}
