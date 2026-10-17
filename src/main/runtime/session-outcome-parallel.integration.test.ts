import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import {
  sessionOutcomeChainConcurrency,
  sessionOutcomeParallelConsent
} from './session-outcome-concurrency'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})

const reviewBody = (id: string) =>
  `REVIEW_BODY_${id}\nOMNI_REVIEW_RESULT:${JSON.stringify({ status: 'pass', blockingFindings: [], notes: 'Reviewed' })}`

function fixture(limit?: number): Fixture {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const step = /STEP:(\w+)/.exec(spec)?.[1]
    if (step) {
      return { body: reviewBody(step) }
    }
    const action = /ACTION:(\w+)/.exec(spec)![1]!
    writeFileSync(join(workspace, `${action}.txt`), `result:${action}`)
    return { body: `Produced ${action}` }
  })
  fixtures.push(f)
  if (limit !== undefined) {
    vi.spyOn(f.runtime, 'getOutcomeChainMaxConcurrentAgents').mockReturnValue(limit)
  }
  return f
}

function chain(workspace: string, steps: SessionChainAgentStep[] = []) {
  return {
    id: 'chain',
    workspacePath: workspace,
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
  }
}

function reviewers(count: number): SessionChainAgentStep[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `r${index + 1}`
    return {
      id,
      outcomeId: 'reviewed',
      agent: 'codex',
      prompt: `STEP:${id}`,
      status: 'queued',
      group: 'review_round_1',
      review: {
        groupId: 'review',
        reviewerId: id,
        round: 1,
        maxRounds: 1,
        candidateVersion: 'unbound'
      }
    }
  })
}

async function commitReview(f: Fixture, count: number): Promise<void> {
  f.write('deliverable.txt', 'candidate')
  const steps = reviewers(count)
  await f.service.commit(chain(f.workspace, steps), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [
      {
        id: 'reviewed',
        title: 'Reviewed deliverable',
        finish: 'complete',
        dependsOn: [],
        stepIds: steps.map((step) => step.id),
        actions: [],
        conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'deliverable.txt') }]
      }
    ]
  })
  f.service.dispose()
}

const definition = (
  id: string,
  dir: string,
  dependsOn: string[] = []
): SessionOutcomeDefinition => ({
  id,
  title: id,
  finish: 'complete',
  dependsOn,
  conditions: [{ id: 'file', kind: 'file', target: join(dir, `${id}.txt`) }],
  actions: [
    {
      id: `write_${id}`,
      instruction: `ACTION:${id}`,
      agent: 'codex',
      conditionIds: ['file'],
      authority: 'existing-user-authority'
    }
  ]
})

const launchedIds = (f: Fixture) =>
  f.launched.map((spec) => (/STEP:(\w+)/.exec(spec) ?? /ACTION:(\w+)/.exec(spec))![1])

const inFlight = (f: Fixture) =>
  f.service
    .get('chain')
    .outcomeSet!.attempts.filter((attempt) =>
      ['prepared', 'launching', 'running'].includes(attempt.state)
    ).length

async function runToEnd(f: Fixture, onTick?: () => void): Promise<void> {
  for (let index = 0; index < 24; index++) {
    await f.settle()
    onTick?.()
  }
}

describe('parallel review rounds on the host executor', () => {
  it('launches every reviewer of a round in the same tick and judges the round on all verdicts', async () => {
    const f = fixture()
    await commitReview(f, 3)

    await f.service.tick()

    expect(launchedIds(f)).toEqual(['r1', 'r2', 'r3'])
    await runToEnd(f)
    const saved = f.service.get('chain')
    // #283 (e65e00002 "mark unanimous report-only reviews passed") moved the unanimous-pass check
    // ahead of the review-only check, so a clean review-only round now passes, not reports.
    expect(saved.reviewLoop!.groups[0]!.status).toBe('passed')
    expect(
      saved.reviewLoop!.groups[0]!.rounds[0]!.receipts.map((receipt) => receipt.status)
    ).toEqual(['pass', 'pass', 'pass'])
    expect(sessionOutcomeProgress(saved.outcomeSet!).lifecycle).toBe('complete')
    expect(f.launched).toHaveLength(3)
  })

  it('caps a round at the concurrency setting and starts the held reviewers as slots free', async () => {
    const f = fixture(2)
    await commitReview(f, 4)

    await f.service.tick()
    expect(launchedIds(f)).toEqual(['r1', 'r2'])
    let peak = 0
    await runToEnd(f, () => {
      peak = Math.max(peak, inFlight(f))
    })

    expect(peak).toBeLessThanOrEqual(2)
    expect(launchedIds(f)).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })

  it('keeps reviewer briefs independent when the chain runs one agent at a time', async () => {
    const f = fixture(1)
    await commitReview(f, 2)

    await f.service.tick()
    expect(launchedIds(f)).toEqual(['r1'])
    await runToEnd(f)

    expect(launchedIds(f)).toEqual(['r1', 'r2'])
    expect(f.launched[1]).not.toContain('REVIEW_BODY_r1')
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })
})

describe('parallel outcome actions on the host executor', () => {
  it('starts independent user-committed outcomes together while a dependent outcome waits', async () => {
    const f = fixture()
    const committed = await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        definition('one', f.workspace),
        definition('two', f.workspace),
        definition('three', f.workspace, ['one'])
      ]
    })
    f.service.dispose()
    expect(committed.parallelOutcomeIds).toEqual(['one', 'two', 'three'])

    await f.service.tick()
    expect(launchedIds(f)).toEqual(['one', 'two'])
    await runToEnd(f)

    expect(launchedIds(f)).toEqual(['one', 'two', 'three'])
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!)).toMatchObject({
      lifecycle: 'complete',
      satisfied: 3
    })
  })

  it('runs outcomes one at a time when no person consented to parallel work', async () => {
    const f = fixture()
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition('one', f.workspace), definition('two', f.workspace)]
    })
    f.service.dispose()
    const saved = f.service.get('chain')
    f.persistence.replaceSessionChainOutcomesAndFlush(
      { ...saved, parallelOutcomeIds: undefined },
      saved.outcomeSet!.revision
    )

    await f.service.tick()
    expect(launchedIds(f)).toEqual(['one'])
    await runToEnd(f, () => expect(inFlight(f)).toBeLessThanOrEqual(1))

    expect(launchedIds(f)).toEqual(['one', 'two'])
  })

  it('honours a concurrency setting of one', async () => {
    const f = fixture(1)
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition('one', f.workspace), definition('two', f.workspace)]
    })
    f.service.dispose()

    await f.service.tick()

    expect(launchedIds(f)).toEqual(['one'])
  })
})

describe('parallel authority', () => {
  const outcomes = [{ id: 'one' }, { id: 'two' }] as SessionOutcomeDefinition[]
  const committed = { outcomeSet: {}, parallelOutcomeIds: ['one'] } as unknown as SessionChain

  it('grants parallel consent only through a person commit', () => {
    expect(sessionOutcomeParallelConsent({ source: 'user', outcomes }, undefined)).toEqual([
      'one',
      'two'
    ])
    expect(sessionOutcomeParallelConsent({ source: 'ai', outcomes }, committed)).toEqual(['one'])
    expect(sessionOutcomeParallelConsent({ source: 'ai', outcomes }, undefined)).toEqual([])
    const unbound = { parallelOutcomeIds: ['one', 'two'] } as unknown as SessionChain
    expect(sessionOutcomeParallelConsent({ source: 'ai', outcomes }, unbound)).toEqual([])
  })

  it('keeps card and native continuations to one agent at a time', () => {
    const runtime = { getOutcomeChainMaxConcurrentAgents: () => 5 }
    const withContinuation = (continuation: Record<string, unknown>) =>
      ({ outcomeSet: { continuation } }) as unknown as SessionChain
    expect(sessionOutcomeChainConcurrency(runtime, withContinuation({}))).toBe(5)
    expect(sessionOutcomeChainConcurrency(runtime, withContinuation({ taskId: 'btk_1' }))).toBe(1)
    expect(
      sessionOutcomeChainConcurrency(runtime, withContinuation({ nativeSource: { runId: 'r' } }))
    ).toBe(1)
  })
})

describe('filing an outcome under a card is not admission', () => {
  it('keeps the executor branch, the run origin and the capacity of a personal chain', async () => {
    const f = fixture(5)
    await f.service.commit(chain(f.workspace), {
      expectedRevision: 0,
      source: 'user',
      outcomes: [definition('one', f.workspace)]
    })
    f.service.dispose()
    const saved = f.service.get('chain')
    const capacityBefore = sessionOutcomeChainConcurrency(f.runtime, saved)

    // The runtime-only write an attach performs: the card is named beside the outcome, never
    // inside `continuation`, so nothing about how this chain executes may change.
    f.persistence.replaceSessionChainOutcomesAndFlush(
      {
        ...saved,
        outcomeSet: {
          ...saved.outcomeSet!,
          outcomes: saved.outcomeSet!.outcomes.map((outcome) => ({
            ...outcome,
            taskRef: { taskId: 'btk_filed', attachedAt: 1 }
          }))
        }
      },
      saved.outcomeSet!.revision
    )
    const filed = f.service.get('chain')

    expect(filed.outcomeSet!.outcomes[0]!.taskRef?.taskId).toBe('btk_filed')
    expect(filed.outcomeSet!.continuation.taskId).toBeUndefined()
    expect(sessionOutcomeChainConcurrency(f.runtime, filed)).toBe(capacityBefore)
    expect(capacityBefore).toBe(5)

    await runToEnd(f)
    const attempt = f.service.get('chain').outcomeSet!.attempts[0]!
    // The local worker branch, not the card continuation adapter.
    expect(attempt.continuationTaskId).toBeUndefined()
    expect(attempt.nativeContinuation).toBeUndefined()
    const run = f.db.getRun(attempt.runId!)!
    expect(run.origin).toBe('personal')
    expect(run.hub_task_id).toBeFalsy()
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })
})
