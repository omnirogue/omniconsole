/**
 * A run an older build sealed on the last review reply while work was still held behind that
 * review: the work never ran. The audit lists it read-only, and says the host releases it as a new
 * run — the seal stands.
 */
import { describe, expect, it } from 'vitest'
import type { SessionChain } from './session-chain-types'
import type { SessionOutcomeSet } from './session-outcome-types'
import { auditSessionRuns } from './session-run-audit'
import { sealSessionRunCompletion } from './session-run-completion'
import { proveRun, runSet } from './session-run-lifecycle.test-fixture'

const NOW = 30_000_000

const chain = (outcomeSet: SessionOutcomeSet, extra: Partial<SessionChain> = {}): SessionChain => ({
  id: 'chn_1',
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: 'row',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'done',
  outcomeSet,
  createdAt: 1,
  updatedAt: 2,
  ...extra
})

const sealed = (): SessionOutcomeSet =>
  sealSessionRunCompletion(proveRun(runSet(), 'one'), { now: NOW, operationId: 'op_seal' })

describe('a sealed run whose held continuation never ran', () => {
  it('is listed with its release as the repair, and the refusal under Details', () => {
    const held = () => ({ reviewStepIds: ['review'], refused: 'upNext.refusal.needsAgent' })
    expect(auditSessionRuns([chain(sealed())], NOW, held)).toEqual([
      {
        chainId: 'chn_1',
        title: 'one',
        state: 'done',
        phase: 'completed',
        findings: ['sealed-with-held-continuation'],
        repair: 'release-continuation',
        reasons: ['upNext.refusal.needsAgent'],
        updatedAt: 1
      }
    ])
  })

  it('lists nothing for a sealed run with nothing held, or a live run that holds work', () => {
    expect(auditSessionRuns([chain(sealed())], NOW, () => null)).toEqual([])
    const live = chain(runSet(), { state: 'waiting' })
    expect(auditSessionRuns([live], NOW, () => ({ reviewStepIds: ['review'] }))).toEqual([])
  })
})
