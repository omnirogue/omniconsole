import { normalizeSessionChain, type SessionChain } from '../../../../shared/session-chain-types'
import {
  recordSessionOutcomeEvidence,
  reviseSessionOutcomeSet
} from '../../../../shared/session-outcome-state'
import { sessionOutcomeConditionKey } from '../../../../shared/session-outcome-types'

const CONDITIONS = [
  { id: 'build', kind: 'file' as const, target: 'dist/app', label: 'IDE build installed' },
  { id: 'receipt', kind: 'report' as const, target: 's1', label: 'receipt signed' },
  { id: 'handoff', kind: 'handoff' as const, target: 'sal', label: 'handoff logged' }
]

/**
 * One pursuit with three Done When conditions, the first already proved: the shape every Outcome
 * head test reads. Built through the real reviser so revisions and receipts behave as the host's.
 */
export function nextActionChainFixture(met = 1): SessionChain {
  let outcomeSet = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'outcome',
          title: 'Verify signed IDE receipt handoff',
          finish: 'complete',
          actions: [],
          dependsOn: [],
          conditions: CONDITIONS
        }
      ]
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
    1
  )
  for (const condition of CONDITIONS.slice(0, met)) {
    outcomeSet = recordSessionOutcomeEvidence(outcomeSet, {
      id: `evidence_${condition.id}`,
      outcomeId: 'outcome',
      conditionId: condition.id,
      outcomeRevision: outcomeSet.outcomes[0]!.revision,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      receipt: `receipt:${condition.id}`,
      verifiedAt: 1_700_000_000_000,
      verifier: 'execution-host'
    })
  }
  return normalizeSessionChain({
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'folder:1',
    hostId: 'local',
    sourcePaneKey: 'source:leaf-1',
    sourceRowKey: 'source',
    auto: true,
    steps: [],
    outcomeSet,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_900_000
  })!
}

/** The same conversation before any chain exists: no outcome set, so no outcome and no pips. */
export function nextActionChainlessFixture(): SessionChain {
  const chain = nextActionChainFixture()
  const { outcomeSet: _dropped, ...rest } = chain
  return rest
}
