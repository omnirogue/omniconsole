import { expect, it } from 'vitest'
import { sessionArchiveProof, sessionCompletionIdentity } from './session-archive-proof'
import { normalizeSessionChain } from './session-chain-types'
import { reviseSessionOutcomeSet, recordSessionOutcomeEvidence } from './session-outcome-state'
import { sealSessionRunCompletion } from './session-run-completion'
import { sessionOutcomeConditionKey, type SessionOutcomeCondition } from './session-outcome-types'

function completed(
  conditions: SessionOutcomeCondition[] = [
    { id: 'merge', kind: 'merge' as const, target: 'https://example.test/pull/1' },
    { id: 'deploy', kind: 'deployment' as const, target: 'production', version: 'sha' },
    { id: 'watch', kind: 'command' as const, target: 'watcher completed' }
  ],
  receiptFor = (condition: SessionOutcomeCondition) => `verified:${condition.id}`
) {
  let set = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'delivery',
          title: 'Merged, deployed and verified',
          finish: conditions.some((condition) => condition.kind === 'deployment')
            ? 'deploy'
            : conditions.some((condition) => condition.kind === 'pr')
              ? 'pr'
              : 'complete',
          dependsOn: [],
          actions: [],
          conditions
        }
      ]
    },
    {
      owner: 'execution-host',
      hostId: 'local',
      epoch: 'epoch',
      state: 'owned',
      sourceVersion: 'turn1',
      sourceReady: true
    },
    1
  )
  for (const condition of conditions) {
    set = recordSessionOutcomeEvidence(set, {
      id: condition.id,
      outcomeId: 'delivery',
      conditionId: condition.id,
      outcomeRevision: 1,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      ...('version' in condition ? { version: condition.version } : {}),
      receipt: receiptFor(condition),
      verifiedAt: 2,
      verifier: 'execution-host'
    })
  }
  return normalizeSessionChain({
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'w',
    sourcePaneKey: 'tab:pane',
    sourceRowKey: 'row',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'done',
    createdAt: 1,
    updatedAt: 3,
    outcomeSet: sealSessionRunCompletion(set, { now: 3, operationId: 'archive' })
  })!
}

it('requires every delivery receipt even when the old seal says complete', () => {
  const chain = completed()
  expect(sessionArchiveProof(chain)).not.toBeNull()
  for (const missing of ['merge', 'deploy', 'watch']) {
    const candidate = structuredClone(chain)
    candidate.outcomeSet!.outcomes[0]!.evidence =
      candidate.outcomeSet!.outcomes[0]!.evidence.filter((entry) => entry.id !== missing)
    expect(sessionArchiveProof(candidate)).toBeNull()
  }
})

it('refuses stale revisions, saved work, unsealed work and drafts awaiting a decision', () => {
  for (const change of [
    (chain: ReturnType<typeof completed>) => {
      delete chain.outcomeSet!.completion
    },
    (chain: ReturnType<typeof completed>) => {
      chain.planVersion = 2
    },
    (chain: ReturnType<typeof completed>) => {
      chain.outcomeSet!.outcomes[0]!.revision++
    },
    (chain: ReturnType<typeof completed>) => {
      chain.outcomeSet!.sessionFinish = { action: 'save' }
    },
    (chain: ReturnType<typeof completed>) => {
      chain.outcomeSet!.sessionFinish = { action: 'me' }
    },
    (chain: ReturnType<typeof completed>) => {
      chain.outcomeSet!.outcomes[0]!.evidence[0]!.receipt = 'done-for-review:v1'
    },
    (chain: ReturnType<typeof completed>) => {
      chain.outcomeSet!.outcomes[0]!.dependsOn = ['unfinished']
    },
    (chain: ReturnType<typeof completed>) => {
      chain.outcomeSet!.continuation.state = 'unverifiable'
    }
  ]) {
    const chain = completed()
    change(chain)
    expect(sessionArchiveProof(chain)).toBeNull()
  }
})

it.each(['session', 'handoff'] as const)(
  'does not treat %s delivery as proof of the whole commitment',
  (kind) => {
    const chain = completed([{ id: 'source', kind, target: 'source' }])
    expect(chain.outcomeSet!.completion).toBeDefined()
    expect(sessionArchiveProof(chain)).toBeNull()
  }
)

it.each(['open', 'closed', 'merged'])(
  'accepts only an already verified merged PR receipt: %s',
  (state) => {
    const chain = completed(
      [{ id: 'pr', kind: 'pr', target: 'https://example.test/pull/1' }],
      () => `https://example.test/pull/1@sha:${state}`
    )
    expect(sessionArchiveProof(chain) !== null).toBe(state === 'merged')
  }
)

it('keeps the archived receipt identity stable through temporary ownership loss', () => {
  const chain = completed()
  const identity = sessionArchiveProof(chain)
  chain.outcomeSet!.continuation.state = 'unverifiable'
  expect(sessionArchiveProof(chain)).toBeNull()
  expect(sessionCompletionIdentity(chain)).toBe(identity)
})

it.each([
  ['handoff-review:hth_review:r1:request_changes', false],
  ['handoff-review:hth_review:r1:approve', true],
  ['user-review:v1', true],
  ['user-review:old', false],
  ['done-for-review:v1', false]
])('requires approval of the current review, not merely its reply: %s', (receipt, accepted) => {
  const chain = completed([{ id: 'review', kind: 'review', target: 'Sal', version: 'v1' }], () =>
    String(receipt)
  )
  expect(sessionArchiveProof(chain) !== null).toBe(accepted)
})
