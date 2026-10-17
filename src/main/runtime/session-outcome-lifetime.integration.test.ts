import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SessionOutcomeService } from './session-outcome-service'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})
async function committed() {
  const f = outcomeRuntimeFixture((_spec, workspace) => {
    writeFileSync(join(workspace, 'result.txt'), 'done')
    return { body: 'done' }
  })
  fixtures.push(f)
  const saved = await f.service.commit(
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
              instruction: 'Produce result',
              authority: 'existing-user-authority',
              agent: 'codex',
              conditionIds: ['file']
            }
          ]
        }
      ]
    }
  )
  f.service.dispose()
  return { f, saved }
}
it('restored work waits for actual continuation ownership and launches exactly once after readiness', async () => {
  const { f } = await committed()
  await f.service.suspend()
  f.runtime.setSessionOutcomeContinuationAvailable(false)
  const restored = new SessionOutcomeService(f.runtime)
  await restored.tick()
  expect(f.launched).toHaveLength(0)
  expect(restored.get('chain').outcomeSet!.attempts).toHaveLength(0)
  f.runtime.setSessionOutcomeContinuationAvailable(true)
  await restored.tick()
  await f.settle()
  await restored.tick()
  await restored.tick()
  // WP-4a: the tick returns before the worker is ready, so the launch it started settles after it.
  await restored.launches.settled()
  expect(f.launched).toHaveLength(1)
  await restored.suspend()
})
it('suspension rejects queued/new mutations without another durable write', async () => {
  const { f, saved } = await committed()
  await f.service.suspend()
  const flush = vi.mocked(f.runtime.replaceSessionChainOutcomesAndFlush)
  flush.mockClear()
  await expect(
    f.service.commit(saved, { expectedRevision: 1, source: 'user', outcomes: [] })
  ).rejects.toThrow('not accepting')
  await expect(f.service.verify('chain', 1, 'result', 'file')).rejects.toThrow('not accepting')
  await expect(f.service.review('chain', 1, 'result', 'file', 'version')).rejects.toThrow(
    'not accepting'
  )
  await expect(f.service.resume('chain', 1)).rejects.toThrow('not accepting')
  await f.service.tick()
  expect(flush).not.toHaveBeenCalled()
  expect(f.launched).toHaveLength(0)
})
it('rejects a mutation queued immediately before suspension instead of executing it after shutdown begins', async () => {
  const { f } = await committed()
  const queued = f.service.verify('chain', 1, 'result', 'file')
  const rejected = expect(queued).rejects.toThrow('not accepting')
  await f.service.suspend()
  await rejected
  expect(f.launched).toHaveLength(0)
})
