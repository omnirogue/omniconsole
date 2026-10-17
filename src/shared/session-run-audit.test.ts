import { describe, expect, it } from 'vitest'
import { agentPromptAttention } from './session-attention-drafts'
import type { SessionChain } from './session-chain-types'
import { openHumanAttention } from './session-human-attention'
import type { SessionOutcomeSet } from './session-outcome-types'
import { auditSessionRuns } from './session-run-audit'
import {
  SESSION_DISPOSITION_MAX_ATTEMPTS,
  recordSessionRunDisposition,
  sealSessionRunCompletion
} from './session-run-completion'
import {
  blockRunOutcome,
  proveRun,
  runAttempt,
  runScope,
  runSet
} from './session-run-lifecycle.test-fixture'

const NOW = 10_000_000
const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'

const chain = (
  outcomeSet: SessionOutcomeSet | undefined,
  extra: Partial<SessionChain> = {}
): SessionChain => ({
  id: 'chn_1',
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: 'row',
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
const sealed = (finish?: SessionOutcomeSet['sessionFinish']): SessionOutcomeSet =>
  sealSessionRunCompletion(
    { ...proven(), ...(finish ? { sessionFinish: finish } : {}) },
    { now: NOW, operationId: 'op_seal' }
  )
const failed = (): SessionOutcomeSet =>
  blockRunOutcome(runSet(), 'one', STALL, { class: 'failed', code: 'worker-stalled', since: NOW })
const asked = (): SessionOutcomeSet =>
  openHumanAttention(
    { ...runSet(), attempts: [runAttempt()] },
    agentPromptAttention({
      scope: runScope({ attemptId: 'att_1' }),
      kind: 'clarification',
      agent: 'Claude',
      prompt: 'Which offer?'
    }),
    NOW
  ).set

describe('runs whose record agrees with itself', () => {
  it('lists nothing for healthy runs in every phase', () => {
    const recovering = blockRunOutcome(runSet(), 'one', STALL, {
      class: 'recovering',
      code: 'worker-stalled',
      since: NOW,
      until: NOW + 15_000
    })
    expect(
      auditSessionRuns(
        [
          chain(runSet()),
          chain(recovering, { id: 'chn_recovering' }),
          chain(asked(), { id: 'chn_asked' }),
          chain(failed(), { id: 'chn_failed', state: 'failed' }),
          chain(sealed(), { id: 'chn_done', state: 'done' })
        ],
        NOW
      )
    ).toEqual([])
  })

  it('does not call a proven outcome unrecorded while its plan still has stages to run', () => {
    const steps = [
      { id: 's1', agent: 'claude', prompt: 'go', status: 'queued' }
    ] as SessionChain['steps']
    expect(auditSessionRuns([chain(proven(), { steps })], NOW)).toEqual([])
  })

  it('skips cancelled runs, quarantined records, and chains with no outcomes', () => {
    expect(
      auditSessionRuns(
        [
          chain(failed(), { state: 'cancelled' }),
          chain(failed(), {
            id: 'chn_quarantined',
            quarantine: { reason: 'newer-schema', detail: 'newer', record: {} }
          }),
          chain(undefined, { id: 'chn_legacy', state: 'failed' })
        ],
        NOW
      )
    ).toEqual([])
  })
})

describe('runs whose record contradicts what it proves', () => {
  it('finds a proven run that was never recorded as done, nor sealed', () => {
    expect(auditSessionRuns([chain(proven())], NOW)).toEqual([
      {
        chainId: 'chn_1',
        title: 'one',
        state: 'waiting',
        phase: 'completed',
        findings: ['complete-not-recorded', 'complete-not-sealed'],
        repair: 'record-completion',
        reasons: [],
        updatedAt: 1
      }
    ])
    // Sealed, but the chain state was lost: only the state is left to repair.
    expect(auditSessionRuns([chain(sealed())], NOW)[0]).toMatchObject({
      findings: ['complete-not-recorded'],
      repair: 'record-completion'
    })
  })

  it('finds a done run that was never sealed', () => {
    expect(auditSessionRuns([chain(proven(), { state: 'done' })], NOW)[0]).toMatchObject({
      phase: 'completed',
      findings: ['complete-not-sealed'],
      repair: 'seal'
    })
  })

  it('finds a blocked outcome no writer classified, and keeps its reason as a diagnostic', () => {
    expect(auditSessionRuns([chain(blockRunOutcome(runSet(), 'one', STALL))], NOW)[0]).toEqual({
      chainId: 'chn_1',
      title: 'one',
      state: 'waiting',
      phase: 'failed',
      findings: ['unclassified-block', 'state-disagrees-with-phase'],
      repair: 'classify',
      reasons: [`one: ${STALL}`],
      updatedAt: 1
    })
  })

  it('finds a chain state that disagrees with the phase the run reads as', () => {
    expect(auditSessionRuns([chain(failed())], NOW)[0]).toMatchObject({
      state: 'waiting',
      phase: 'failed',
      findings: ['state-disagrees-with-phase'],
      repair: 'rewrite-state'
    })
    expect(auditSessionRuns([chain(runSet(), { state: 'failed' })], NOW)[0]).toMatchObject({
      state: 'failed',
      phase: 'active',
      findings: ['state-disagrees-with-phase'],
      repair: 'rewrite-state'
    })
  })

  it('finds a request left open for an attempt the run no longer has', () => {
    const stale: SessionOutcomeSet = {
      ...asked(),
      attempts: [runAttempt({ state: 'superseded' })]
    }
    expect(auditSessionRuns([chain(stale)], NOW)[0]).toMatchObject({
      phase: 'active',
      findings: ['stale-attention'],
      repair: 'withdraw-attention'
    })
  })

  it('finds a sealed run whose close or save ran out of retries, and offers no repair', () => {
    const exhausted = Array.from({
      length: SESSION_DISPOSITION_MAX_ATTEMPTS
    }).reduce<SessionOutcomeSet>(
      (next, _entry, index) =>
        recordSessionRunDisposition(next, { operationId: 'op_seal', ok: false }, NOW + index),
      sealed({ action: 'end' })
    )
    expect(auditSessionRuns([chain(exhausted, { state: 'done' })], NOW + 99)[0]).toMatchObject({
      phase: 'completed',
      findings: ['disposition-failed'],
      repair: 'none'
    })
  })

  it('reads and repairs nothing: the chains it was given are untouched', () => {
    const chains = [chain(proven()), chain(failed(), { id: 'chn_failed' })]
    const before = structuredClone(chains)
    expect(auditSessionRuns(chains, NOW).map((row) => row.chainId)).toEqual(['chn_1', 'chn_failed'])
    expect(chains).toEqual(before)
  })
})
