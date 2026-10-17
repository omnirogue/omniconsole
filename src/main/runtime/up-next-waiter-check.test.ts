import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeSessionChain, type SessionChain } from '../../shared/session-chain-types'
import {
  recordSessionOutcomeEvidence,
  reviseSessionOutcomeSet
} from '../../shared/session-outcome-state'
import { sessionOutcomeConditionKey } from '../../shared/session-outcome-types'
import { sealSessionRunCompletion } from '../../shared/session-run-completion'
import { setSessionWaitersSource } from '../session-steward/steward-waiter-source'
import { configureStewardSwitches } from '../session-steward/steward-switches'
import { conversationId, harness, rowKey } from './rpc/methods/up-next-harness'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({
    ready: true,
    free: true,
    unverifiable: false,
    version: 'turn1'
  })
}))

const cleanups: (() => void)[] = []
const settings: Record<string, unknown> = {}
beforeEach(() => {
  cleanups.push(configureStewardSwitches({ readSettings: () => settings, environment: {} }))
})
afterEach(() => {
  delete settings.tier1WaiterCheck
  while (cleanups.length) {
    cleanups.pop()!()
  }
})

/** A finished commitment with every receipt, sealed and closed: Tier 1's own archive proof. */
function provenChain(): SessionChain {
  const condition = { id: 'merge', kind: 'merge' as const, target: 'https://example.test/pull/1' }
  let set = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'delivery',
          title: 'Merged',
          finish: 'complete',
          dependsOn: [],
          actions: [],
          conditions: [condition]
        }
      ]
    },
    {
      owner: 'execution-host',
      hostId: 'local',
      epoch: 'epoch-1',
      state: 'owned',
      sourceVersion: 'turn1',
      sourceReady: true
    },
    1
  )
  set = recordSessionOutcomeEvidence(set, {
    id: condition.id,
    outcomeId: 'delivery',
    conditionId: condition.id,
    outcomeRevision: 1,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    receipt: 'verified:merge',
    verifiedAt: 2,
    verifier: 'execution-host'
  })
  const sealed = sealSessionRunCompletion(set, { now: 3, operationId: 'op-seal' })
  return normalizeSessionChain({
    id: 'chain',
    workspacePath: '/w',
    worktreeId: conversationId.worktreeId,
    sourcePaneKey: conversationId.paneKey,
    sourceRowKey: rowKey,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'done',
    createdAt: 1,
    updatedAt: 3,
    outcomeSet: {
      ...sealed,
      disposition: {
        intent: 'completed',
        state: 'applied',
        operationId: 'op-seal',
        attempts: 1,
        appliedAt: 4,
        updatedAt: 4
      }
    }
  })!
}

const proof = async () =>
  (await harness({}, { chains: [provenChain()] }).call('upNext.list', { conversationId })).view
    .archiveProof

it('keeps a proven session another session waits on, until the wait is gone', async () => {
  const unawaited = await proof()
  expect(unawaited).toEqual(expect.any(String))
  cleanups.push(
    setSessionWaitersSource(() => new Map([[conversationId.paneKey, ['tab-9:leaf-1']]]))
  )
  expect(await proof()).toBeUndefined()
  settings.tier1WaiterCheck = false
  expect(await proof()).toBe(unawaited)
})
