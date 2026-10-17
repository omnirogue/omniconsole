import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SessionOutcomeService } from './session-outcome-service'

/**
 * A finished outcome whose proof is already on disk reaches `satisfied` and seals, whoever finishes
 * it: the owner that earned the proof, or a replacement owner that runs only the last stage. The
 * last stage here proves nothing new, so no fresh receipt re-derives the status on the way.
 */
type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
const restoredServices: SessionOutcomeService[] = []
afterEach(async () => {
  for (const service of restoredServices.splice(0)) {
    await service.suspend()
  }
  for (const f of fixtures.splice(0).toReversed()) {
    await f.dispose()
  }
})

const stage = (id: string): SessionChainAgentStep =>
  ({
    id,
    outcomeId: 'ship',
    agent: 'codex',
    prompt: `STEP:${id}`,
    status: 'queued'
  }) as SessionChainAgentStep

function fixture(): Fixture {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    // Only the first stage earns the proof; the stage after it adds nothing the verifier reads.
    if (/STEP:(\w+)/.exec(spec)![1] === 'work') {
      writeFileSync(join(workspace, 'result.txt'), 'the result')
    }
    return { body: 'Reported' }
  })
  fixtures.push(f)
  // Why stubbed: the commit's own startup pass would run unawaited beside the ticks each test drives.
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  return f
}

async function commit(f: Fixture): Promise<void> {
  await f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
      steps: [stage('work'), stage('publish')],
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    },
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'ship',
          title: 'Ship the result',
          finish: 'complete',
          dependsOn: [],
          stepIds: ['work', 'publish'],
          actions: [],
          conditions: [{ id: 'result', kind: 'file', target: join(f.workspace, 'result.txt') }]
        }
      ]
    }
  )
}

const record = (f: Fixture): SessionChain => f.service.get('chain')

function expectSealedSatisfied(f: Fixture): void {
  const chain = record(f)
  expect(chain.outcomeSet!.completedSteps).toEqual(['work', 'publish'])
  expect(chain.outcomeSet!.completion).toBeDefined()
  expect(chain.state).toBe('done')
  // A sealed set is never reconciled again: the status it was sealed with is the one it keeps.
  expect(chain.outcomeSet!.outcomes.map((outcome) => outcome.status)).toEqual(['satisfied'])
  expect(sessionOutcomeProgress(chain.outcomeSet!)).toMatchObject({
    phase: 'completed',
    satisfied: 1,
    total: 1
  })
  expect(f.launched).toHaveLength(2)
}

it('seals a local run whose last stage adds no proof with its outcome satisfied', async () => {
  const f = fixture()
  await commit(f)
  for (let index = 0; index < 12 && !record(f).outcomeSet!.completion; index++) {
    await f.settle()
  }
  expectSealedSatisfied(f)
})

it('lets a replacement owner finish a run whose proof the first owner earned, and seals it satisfied', async () => {
  const f = fixture()
  await commit(f)
  for (
    let index = 0;
    index < 12 && !record(f).outcomeSet!.completedSteps?.includes('work');
    index++
  ) {
    await f.settle()
  }
  expect(record(f).outcomeSet!.outcomes[0]!.evidence).toHaveLength(1)
  expect(record(f).outcomeSet!.completion).toBeUndefined()
  await f.service.suspend()

  const restored = new SessionOutcomeService(f.runtime)
  restoredServices.push(restored)
  for (let index = 0; index < 12 && !record(f).outcomeSet!.completion; index++) {
    await restored.tick()
    await restored.launches.settled()
    await f.settleReports()
  }
  expectSealedSatisfied(f)
})

it('reads the process clock on every pass, so a clock installed after construction is the one used', () => {
  const f = fixture()
  const later = Date.now() + 31_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
  try {
    // Captured at construction, the host kept the old clock and a 30 s evidence poll never came due.
    expect(f.service.now()).toBe(later)
  } finally {
    clock.mockRestore()
  }
})
