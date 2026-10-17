import { describe, expect, it } from 'vitest'
import { ownReviewAttention } from '../../shared/session-attention-drafts'
import type { SessionChain } from '../../shared/session-chain-types'
import { openHumanAttention } from '../../shared/session-human-attention'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import { sealSessionRunCompletion } from '../../shared/session-run-completion'
import {
  blockRunOutcome,
  proveRun,
  runScope,
  runSet
} from '../../shared/session-run-lifecycle.test-fixture'
import {
  finishedSessionOutcomeNeedsRepair,
  pendingSessionOutcomeChains,
  sessionOutcomeStateDisagrees,
  sessionOutcomeTickDuty
} from './session-outcome-reconcile'

const NOW = 9_000_000
const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'

const chain = (
  id: string,
  outcomeSet: SessionOutcomeSet | undefined,
  extra: Partial<SessionChain> = {}
): SessionChain => ({
  id,
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: `tab-${id}:leaf`,
  sourceRowKey: `row-${id}`,
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  ...(outcomeSet ? { outcomeSet } : {}),
  createdAt: 1,
  updatedAt: 2,
  ...extra
})

const proven = (): SessionOutcomeSet => proveRun(runSet(), 'one')
const sealed = (): SessionOutcomeSet =>
  sealSessionRunCompletion(proven(), { now: NOW, operationId: 'op_seal' })
const failed = (): SessionOutcomeSet =>
  blockRunOutcome(runSet(), 'one', STALL, { class: 'failed', code: 'worker-stalled', since: NOW })
const asked = (): SessionOutcomeSet =>
  openHumanAttention(
    runSet(),
    ownReviewAttention({ scope: { ...runScope(), conditionId: 'file' }, title: 'one' }),
    NOW
  ).set
const twoStages = {
  steps: [
    { id: 's1', agent: 'codex' as const, prompt: 'One', status: 'launched' as const },
    { id: 's2', agent: 'codex' as const, prompt: 'Two', status: 'queued' as const }
  ],
  currentIndex: 1
}

describe('what the tick owes a chain', () => {
  it.each([
    ['healthy sealed run', chain('a', sealed(), { state: 'done' }), 'skip'],
    ['sealed but recorded as waiting', chain('b', sealed(), { state: 'waiting' }), 'repair'],
    ['proven, never recorded or sealed', chain('c', proven(), { state: 'waiting' }), 'repair'],
    ['recorded done, never sealed', chain('d', proven(), { state: 'done' }), 'repair'],
    ['cancelled with complete proof', chain('e', proven(), { state: 'cancelled' }), 'skip'],
    ['running work', chain('g', runSet()), 'advance'],
    ['failed work', chain('h', failed(), { state: 'failed' }), 'advance'],
    ['a legacy plan with no outcomes', chain('i', undefined), 'skip']
  ] as const)('%s -> %s', (_name, candidate, duty) => {
    expect(sessionOutcomeTickDuty(candidate, NOW)).toBe(duty)
  })

  it('never touches a quarantined record', () => {
    const quarantined = {
      ...chain('q', proven()),
      quarantine: { reason: 'unreadable', detail: 'x', record: {} }
    } as unknown as SessionChain
    expect(sessionOutcomeTickDuty(quarantined, NOW)).toBe('skip')
    expect(finishedSessionOutcomeNeedsRepair(quarantined, NOW)).toBe(false)
    expect(pendingSessionOutcomeChains([quarantined], NOW)).toEqual([])
  })
})

describe('a persisted state that contradicts its own reading', () => {
  it.each([
    ['failed work recorded as waiting', chain('a', failed(), { state: 'waiting' }), true],
    ['failed work recorded as failed', chain('b', failed(), { state: 'failed' }), false],
    ['recovered work still recorded as failed', chain('c', runSet(), { state: 'failed' }), true],
    ['a run asking its owner something', chain('d', asked(), { state: 'waiting' }), false],
    ['proven with every stage done', chain('e', proven(), { state: 'waiting' }), true],
    ['a proven stage with stages ahead', chain('f', proven(), twoStages), false],
    ['sealed', chain('g', sealed(), { state: 'waiting' }), false],
    ['cancelled', chain('h', failed(), { state: 'cancelled' }), false]
  ] as const)('%s -> %s', (_name, candidate, disagrees) => {
    expect(sessionOutcomeStateDisagrees(candidate, NOW)).toBe(disagrees)
  })
})

it('keeps a headless host alive only for runs that can still move by themselves', () => {
  const chains = [
    chain('sealed', sealed(), { state: 'done' }),
    chain('unsealed', proven(), { state: 'waiting' }),
    chain('failed', failed(), { state: 'failed' }),
    chain('legacy-block', blockRunOutcome(runSet(), 'one', STALL)),
    chain('cancelled', runSet(), { state: 'cancelled' }),
    chain('running', runSet()),
    chain('asking', asked()),
    chain('legacy', undefined)
  ]
  expect(pendingSessionOutcomeChains(chains, NOW).map((entry) => entry.id)).toEqual([
    'running',
    'asking'
  ])
})
