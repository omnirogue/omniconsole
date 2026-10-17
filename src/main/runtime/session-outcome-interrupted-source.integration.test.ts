import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})

it.each([
  {
    cause: 'an interrupted source',
    interrupted: true,
    failed: false,
    failureReason: undefined,
    expectedReason: 'interrupted'
  },
  {
    cause: 'a source quota failure',
    interrupted: false,
    failed: true,
    failureReason: 'API usage limit reached.',
    expectedReason: 'API usage limit reached.'
  },
  {
    cause: 'a source authentication failure',
    interrupted: false,
    failed: true,
    failureReason: 'Authentication failed: session expired.',
    expectedReason: 'Authentication failed: session expired.'
  }
])(
  'holds queued work on $cause and launches once after fresh successful completion',
  async (blocked) => {
    const f = outcomeRuntimeFixture(() => {
      f.write('result.txt', 'Verified result from the queued worker.')
      return { body: 'Created result.txt' }
    })
    fixtures.push(f)
    const now = Date.now()
    let source = {
      state: 'done',
      interrupted: blocked.interrupted,
      failed: blocked.failed,
      failureReason: blocked.failureReason,
      terminalHandle: 'source',
      lastAssistantMessage: 'Source work did not finish.',
      stateStartedAt: now,
      receivedAt: now
    }
    // Keep the real accessor so dropped failure/cancellation flags cannot admit a successor.
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockRestore()
    Object.assign(f.runtime, { getAgentStatusSnapshotFn: () => [source] })
    vi.spyOn(f.runtime, 'readTerminal').mockResolvedValue({ status: 'exited', tail: [] } as never)
    const chain: SessionChain = {
      id: 'interrupted-source',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'source',
      auto: true,
      steps: [],
      currentIndex: 0,
      state: 'waiting',
      createdAt: now,
      updatedAt: now
    }
    await f.service.commit(chain, {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'result',
          title: 'Create the result after the source finishes',
          finish: 'complete',
          dependsOn: [],
          conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'result.txt') }],
          actions: [
            {
              id: 'write',
              instruction: 'Create result.txt.',
              agent: 'codex',
              authority: 'existing-user-authority',
              conditionIds: ['file']
            }
          ]
        }
      ]
    })
    f.service.dispose()
    await f.service.tick()
    await f.service.tick()
    const stopped = f.service.get(chain.id).outcomeSet!
    expect(stopped.continuation.sourceReady).not.toBe(true)
    expect(stopped.attempts).toHaveLength(0)
    expect(stopped.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: expect.stringContaining(blocked.expectedReason)
    })
    expect(f.launched).toHaveLength(0)
    expect(f.runtime.readTerminal).not.toHaveBeenCalled()

    source = {
      ...source,
      state: 'working',
      interrupted: false,
      failed: false,
      failureReason: undefined,
      receivedAt: Date.now()
    }
    await f.service.tick()
    expect(f.launched).toHaveLength(0)
    source = {
      ...source,
      state: 'done',
      lastAssistantMessage: 'Source work completed successfully.',
      stateStartedAt: Date.now(),
      receivedAt: Date.now()
    }
    for (let index = 0; index < 6; index++) {
      await f.service.tick()
      await f.settle()
    }
    const completed = f.service.get(chain.id).outcomeSet!
    expect(sessionOutcomeProgress(completed).lifecycle).toBe('complete')
    expect(completed.attempts).toHaveLength(1)
    expect(completed.attempts[0]).toMatchObject({
      state: 'completed',
      dispatchId: expect.any(String)
    })
    expect(f.launched).toHaveLength(1)
  }
)
