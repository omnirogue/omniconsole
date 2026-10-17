import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SessionOutcomeService } from './session-outcome-service'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

/** Three planners side by side, then one seat that reads all three. Sal's example, in miniature. */
function planners(): SessionChainAgentStep[] {
  const group = (id: string): SessionChainAgentStep =>
    ({
      id,
      outcomeId: 'plan',
      agent: 'codex',
      prompt: `STEP:${id}`,
      status: 'queued',
      group: 'research'
    }) as SessionChainAgentStep
  return [
    group('p1'),
    group('p2'),
    group('p3'),
    {
      id: 'synth',
      outcomeId: 'plan',
      agent: 'codex',
      prompt: 'STEP:synth',
      status: 'queued',
      readsFrom: ['p1', 'p2', 'p3']
    } as SessionChainAgentStep
  ]
}

function fixture(limit?: number): Fixture {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const id = /STEP:(\w+)/.exec(spec)![1]!
    if (id === 'p1') {
      writeFileSync(join(workspace, 'stage1.txt'), 'first stage done')
    }
    if (id === 'synth') {
      writeFileSync(join(workspace, 'plan.md'), 'the plan')
    }
    return { body: `REPORT_FROM_${id}` }
  })
  fixtures.push(f)
  if (limit !== undefined) {
    vi.spyOn(f.runtime, 'getOutcomeChainMaxConcurrentAgents').mockReturnValue(limit)
  }
  return f
}

async function commit(f: Fixture): Promise<void> {
  const steps = planners()
  await f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
      steps,
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
          id: 'plan',
          title: 'Plan the launch',
          finish: 'complete',
          dependsOn: [],
          stepIds: steps.map((step) => step.id),
          actions: [],
          conditions: [
            { id: 'stage1', kind: 'file', target: join(f.workspace, 'stage1.txt') },
            { id: 'plan', kind: 'file', target: join(f.workspace, 'plan.md') }
          ]
        }
      ]
    }
  )
  f.service.dispose()
}

const launchedIds = (f: Fixture): string[] => f.launched.map((spec) => /STEP:(\w+)/.exec(spec)![1]!)

const waitOf = (f: Fixture, id: string) =>
  (f.service.get('chain').steps.find((step) => step.id === id) as SessionChainAgentStep).wait

async function runToEnd(f: Fixture, onTick?: () => void): Promise<void> {
  for (let index = 0; index < 24; index++) {
    await f.settle()
    onTick?.()
  }
}

describe('a parallel group on an ordinary chain', () => {
  it('launches every seat of the group in one tick, and not the seat that reads them', async () => {
    const f = fixture()
    await commit(f)

    await f.service.tick()

    expect(launchedIds(f)).toEqual(['p1', 'p2', 'p3'])
    expect(waitOf(f, 'synth')).toBeUndefined()
  })

  it('holds the seats past the budget and says why, then starts them as slots free', async () => {
    const f = fixture(2)
    await commit(f)

    await f.service.tick()
    expect(launchedIds(f)).toEqual(['p1', 'p2'])
    expect(waitOf(f, 'p3')).toMatchObject({ reason: 'capacity' })

    let peak = 0
    await runToEnd(f, () => {
      peak = Math.max(
        peak,
        f.service
          .get('chain')
          .outcomeSet!.attempts.filter((attempt) =>
            ['prepared', 'launching', 'running'].includes(attempt.state)
          ).length
      )
    })

    expect(peak).toBeLessThanOrEqual(2)
    expect(launchedIds(f)).toEqual(['p1', 'p2', 'p3', 'synth'])
    expect(waitOf(f, 'p3')).toBeUndefined()
  })

  it('gives the seat after the group one labelled excerpt per producer it reads', async () => {
    const f = fixture()
    await commit(f)
    await runToEnd(f)

    const brief = f.launched.find((spec) => spec.includes('STEP:synth'))!
    expect(brief).toContain('=== p1 ===')
    expect(brief).toContain('=== p2 ===')
    expect(brief).toContain('=== p3 ===')
    expect(brief).toContain('REPORT_FROM_p2')
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })

  it('raises Done When stage by stage instead of only at the end', async () => {
    const f = fixture()
    await commit(f)
    const receiptsWhileRunning: number[] = []
    for (let index = 0; index < 24; index++) {
      await f.settle()
      const chain = f.service.get('chain')
      const outcome = chain.outcomeSet!.outcomes[0]!
      // The moment the group is done and the seat reading it is still working.
      if (
        ['p1', 'p2', 'p3'].every((id) => chain.outcomeSet!.completedSteps?.includes(id)) &&
        !chain.outcomeSet!.completedSteps?.includes('synth')
      ) {
        receiptsWhileRunning.push(outcome.evidence.length)
        expect(outcome.status).not.toBe('satisfied')
      }
    }

    // stage1.txt was proved by the first stage; the plan file only exists at the end.
    expect(Math.max(...receiptsWhileRunning)).toBe(1)
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.evidence).toHaveLength(2)
  })
})

describe('a wait is this host, not the plan', () => {
  it('is never inherited by a restarted host', async () => {
    const f = fixture(1)
    await commit(f)
    await f.service.tick()
    expect(waitOf(f, 'p2')).toMatchObject({ reason: 'capacity' })
    // A wait recorded for a seat that is no longer held: only the restart can clear it.
    const held = f.service.get('chain')
    f.persistence.replaceSessionChainOutcomesAndFlush(
      {
        ...held,
        steps: held.steps.map((step) =>
          step.id === 'p1' ? { ...step, wait: { reason: 'capacity', since: 1 } } : step
        )
      } as SessionChain,
      held.outcomeSet!.revision
    )
    await f.service.suspend()

    const restarted = new SessionOutcomeService(f.runtime)
    await restarted.tick()
    await restarted.launches.settled()

    const steps = restarted.get('chain').steps as SessionChainAgentStep[]
    expect(steps.find((step) => step.id === 'p1')!.wait).toBeUndefined()
    await restarted.suspend()
  })
})
