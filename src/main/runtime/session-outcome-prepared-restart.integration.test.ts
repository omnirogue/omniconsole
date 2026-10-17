import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

const worker = (_spec: string, workspace: string) => {
  writeFileSync(join(workspace, 'result.txt'), 'Completed after durable restart')
  return { body: 'Produced result.txt' }
}

it.each(['prepared', 'coordinator', 'run'] as const)(
  'recovers a crash after persisting %s and launches exactly one worker on explicit resume',
  async (checkpoint) => {
    const f = outcomeRuntimeFixture(worker)
    fixtures.push(f)
    await f.service.commit(
      {
        id: 'chain',
        workspacePath: f.workspace,
        worktreeId: 'folder:outcome',
        hostId: 'local',
        sourcePaneKey: 'source',
        sourceRowKey: 'row',
        auto: true,
        steps: [],
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
            id: 'result',
            title: 'Result',
            finish: 'complete',
            dependsOn: [],
            conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'result.txt') }],
            actions: [
              {
                id: 'produce',
                instruction: 'Produce result.txt',
                agent: 'codex',
                conditionIds: ['file'],
                authority: 'existing-user-authority'
              }
            ]
          }
        ]
      }
    )
    f.service.dispose()
    const persist = vi.mocked(f.runtime.replaceSessionChainOutcomesAndFlush)
    const original = persist.getMockImplementation()!
    let crashed = false
    persist.mockImplementation((chain, revision) => {
      if (crashed) {
        throw new Error('Simulated host process death')
      }
      const saved = original(chain, revision)
      const attempt = saved.outcomeSet!.attempts[0]
      if (
        (checkpoint === 'prepared' && attempt?.state === 'prepared') ||
        (checkpoint === 'coordinator' &&
          attempt?.state === 'prepared' &&
          attempt.coordinatorHandle) ||
        (checkpoint === 'run' && attempt?.state === 'launching' && attempt.runId)
      ) {
        crashed = true
        throw new Error('Simulated host process death')
      }
      return saved
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await f.service.tick()
    expect(crashed).toBe(true)
    expect(f.launched).toHaveLength(0)
    const durable = JSON.parse(readFileSync(join(f.workspace, '.omni', 'state.json'), 'utf8'))
    const abandoned = durable.sessionChains[0].outcomeSet.attempts[0] as SessionOutcomeAttempt
    expect(abandoned.state).toBe(checkpoint === 'run' ? 'launching' : 'prepared')
    expect(abandoned.taskId).toBeUndefined()
    expect(abandoned.dispatchId).toBeUndefined()
    expect(Boolean(abandoned.coordinatorHandle)).toBe(checkpoint !== 'prepared')
    expect(Boolean(abandoned.runId)).toBe(checkpoint === 'run')
    await f.service.suspend()
    f.closeDatabase()

    const reopened = outcomeRuntimeFixture(worker, f.workspace)
    fixtures.push(reopened)
    await reopened.service.tick()
    await reopened.service.tick()
    expect(reopened.launched).toHaveLength(0)
    expect(reopened.service.get('chain').outcomeSet!.attempts).toMatchObject([
      {
        id: abandoned.id,
        state: 'blocked',
        launchDisposition: 'not-started',
        failure: { code: 'launch-not-started' }
      }
    ])
    // A launch that provably never started is the host's to retry after its backoff — which has
    // not run out yet here — and is never a request for the person. The Resume below is the
    // person not waiting for it.
    expect(sessionOutcomeProgress(reopened.service.get('chain').outcomeSet!)).toMatchObject({
      phase: 'recovering',
      lifecycle: 'waiting',
      attention: []
    })
    await reopened.service.resume('chain', 1)
    for (let index = 0; index < 5; index++) {
      await reopened.service.tick()
      await reopened.settle()
    }
    const saved = reopened.service.get('chain')
    expect(sessionOutcomeProgress(saved.outcomeSet!).lifecycle).toBe('complete')
    expect(reopened.launched).toHaveLength(1)
    expect(saved.outcomeSet!.attempts).toHaveLength(2)
    expect(saved.outcomeSet!.attempts[0]).toMatchObject({
      id: abandoned.id,
      state: 'retryable',
      launchDisposition: 'not-started'
    })
    const completed = saved.outcomeSet!.attempts[1]!
    expect(completed.state).toBe('completed')
    expect(reopened.db.getDispatchContext(completed.taskId!)?.id).toBe(completed.dispatchId)
    await reopened.service.suspend()
    reopened.closeDatabase()

    const final = outcomeRuntimeFixture(worker, f.workspace)
    fixtures.push(final)
    await final.service.resume('chain', 1)
    await final.service.tick()
    await final.service.tick()
    expect(final.launched).toHaveLength(0)
    expect(final.service.get('chain').outcomeSet!.attempts).toEqual(saved.outcomeSet!.attempts)
    expect(sessionOutcomeProgress(final.service.get('chain').outcomeSet!).lifecycle).toBe(
      'complete'
    )
  }
)
