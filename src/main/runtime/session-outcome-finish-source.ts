import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit, SessionOutcomeSet } from '../../shared/session-outcome-types'
import { reconcileSessionOutcomeSet } from '../../shared/session-outcome-state'

export function bindSessionFinishSource(
  input: SessionOutcomeCommit,
  chain: SessionChain
): SessionOutcomeCommit {
  if (
    !input.sessionFinish ||
    input.outcomes.some((outcome) =>
      outcome.conditions.some(
        (condition) => condition.kind === 'session' && condition.target === chain.sourcePaneKey
      )
    )
  ) {
    return input
  }
  const first = input.outcomes[0]!
  const existing = new Set(first.conditions.map((condition) => condition.id))
  let id = 'session_finish_source'
  for (let index = 1; existing.has(id); index += 1) {
    id = `session_finish_source_${index}`
  }
  return {
    ...input,
    outcomes: [
      {
        ...first,
        conditions: [...first.conditions, { id, kind: 'session', target: chain.sourcePaneKey }]
      },
      ...input.outcomes.slice(1)
    ]
  }
}

/** Only an explicit, authorized finish submission can replace the source receipt. */
export function rebindSessionFinishSource(
  set: SessionOutcomeSet,
  input: SessionOutcomeCommit
): SessionOutcomeSet {
  if (!input.sessionFinish) {
    return set
  }
  const invalid = set.outcomes.flatMap((outcome) =>
    outcome.evidence.filter((entry) => entry.kind === 'session')
  )
  return reconcileSessionOutcomeSet({
    ...set,
    continuation: { ...set.continuation, sourceReady: false, sourceVersion: undefined },
    evidenceHistory: [...(set.evidenceHistory ?? []), ...invalid],
    outcomes: set.outcomes.map((outcome) => ({
      ...outcome,
      evidence: outcome.evidence.filter((entry) => entry.kind !== 'session')
    }))
  })
}

export function sessionFinishSourceMismatch(
  set: SessionOutcomeSet,
  version?: string
): string | undefined {
  const expected = [
    ...(set.continuation.sourceVersion ? [set.continuation.sourceVersion] : []),
    ...set.outcomes.flatMap((outcome) =>
      outcome.evidence
        .filter((entry) => entry.kind === 'session' && entry.version)
        .map((entry) => entry.version!)
    )
  ]
  if (!expected.length || !version) {
    return 'This completion setting has no exact source receipt. Review Next and save it again to bind the current turn.'
  }
  if (expected.some((prior) => prior !== version)) {
    return 'The source advanced since this completion setting was saved. Review Next and save it again to bind the current turn.'
  }
  return undefined
}
