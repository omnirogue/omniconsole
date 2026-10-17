import { expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import {
  reviseSessionOutcomeSet,
  recordSessionOutcomeEvidence
} from '../../shared/session-outcome-state'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import {
  bindSessionFinishSource,
  rebindSessionFinishSource,
  sessionFinishSourceMismatch
} from './session-outcome-finish-source'

const input: SessionOutcomeCommit = {
  source: 'user',
  expectedRevision: 0,
  sessionFinish: { action: 'save' },
  outcomes: [
    {
      id: 'result',
      title: 'Deliver the report',
      finish: 'complete',
      dependsOn: [],
      actions: [],
      conditions: [
        { id: 'file', kind: 'file', target: '/work/report.md' },
        { id: 'review', kind: 'review', target: 'result' }
      ]
    }
  ]
}
const chain = { sourcePaneKey: 'tab:leaf' } as SessionChain
const owner = {
  owner: 'execution-host',
  hostId: 'local',
  epoch: 'epoch',
  state: 'owned',
  sourceReady: true,
  sourceVersion: 'old-turn'
} as const

it('binds source completion without creating a writer or duplicating its condition', () => {
  const bound = bindSessionFinishSource(input, chain)
  expect(bound.outcomes[0]!.conditions).toContainEqual({
    id: 'session_finish_source',
    kind: 'session',
    target: 'tab:leaf'
  })
  expect(bound.outcomes[0]!.actions).toBe(input.outcomes[0]!.actions)
  expect(bindSessionFinishSource(bound, chain)).toBe(bound)
})

it('requires the same source receipt and explicitly rebinds only session evidence', () => {
  const bound = bindSessionFinishSource(input, chain)
  let set = reviseSessionOutcomeSet(undefined, bound, owner, 1)
  set.attempts = [
    {
      id: 'sent',
      outcomeId: 'result',
      actionId: 'send-gamma',
      actionKey: 'accepted-send-key',
      outcomeRevision: 1,
      state: 'completed',
      resultMessageId: 'delivered-receipt',
      startedAt: 1,
      updatedAt: 2
    }
  ]
  for (const condition of set.outcomes[0]!.conditions) {
    set = recordSessionOutcomeEvidence(
      set,
      sessionOutcomeVerifiedEvidence(
        set.outcomes[0]!,
        condition,
        condition.id,
        2,
        condition.kind === 'session' ? 'old-turn' : 'file-version'
      )
    )
  }
  expect(sessionFinishSourceMismatch(set, 'old-turn')).toBeUndefined()
  expect(sessionFinishSourceMismatch(set, 'new-turn')).toContain('source advanced')
  const priorEvidence = set.outcomes[0]!.evidence.filter((entry) => entry.kind !== 'session')
  const revised = reviseSessionOutcomeSet(set, { ...bound, expectedRevision: 1 }, owner, 3)
  const rebound = rebindSessionFinishSource(revised, bound)
  expect(rebound.continuation).toMatchObject({ sourceReady: false, sourceVersion: undefined })
  expect(rebound.outcomes[0]!.evidence).toEqual(priorEvidence)
  expect(rebound.attempts).toBe(revised.attempts)
  expect(rebound.attempts).toEqual(set.attempts)
  expect(rebound.evidenceHistory?.filter((entry) => entry.kind === 'session')).toHaveLength(1)
  expect(sessionFinishSourceMismatch(rebound, 'old-turn')).toContain('no exact source receipt')
  const session = rebound.outcomes[0]!.conditions.find((condition) => condition.kind === 'session')!
  const current = recordSessionOutcomeEvidence(
    rebound,
    sessionOutcomeVerifiedEvidence(rebound.outcomes[0]!, session, 'new-turn', 4, 'new-turn')
  )
  expect(sessionFinishSourceMismatch(current, 'new-turn')).toBeUndefined()
  expect(current.outcomes[0]!.actions).toEqual(input.outcomes[0]!.actions)
})

it('does not upgrade a legacy receipt when no explicit finish choice was submitted', () => {
  const legacy = reviseSessionOutcomeSet(undefined, input, owner, 1)
  const passive = { ...input, sessionFinish: undefined }
  expect(rebindSessionFinishSource(legacy, passive)).toBe(legacy)
  expect(sessionFinishSourceMismatch(legacy, 'new-identity-digest')).toContain('save it again')
})
