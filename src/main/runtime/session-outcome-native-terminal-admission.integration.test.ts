import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { createOrchestrationCaller } from './build-review/build-review-rpc-call'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})

it('keeps the real terminal boundary closed for a card-linked Run without server activation', async () => {
  const f = outcomeRuntimeFixture(() => ({ body: 'must not run' }))
  fixtures.push(f)
  // Exercise createTerminal itself; replacing this method hid the live admission refusal.
  vi.mocked(f.runtime.createTerminal).mockRestore()
  const spawn = vi.fn(async () => {
    throw new Error('No provider process is authorized')
  })
  f.runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const call = createOrchestrationCaller(f.runtime)
  const admitted = await call<{ run: { id: string }; projectionTaskId: string }>(
    'orchestration.runCreate',
    {
      from: 'term_source_coordinator',
      objective: 'The whole outcome still requires review and human handoff',
      hubTaskId: 'btk_nativeoutcomes'
    }
  )
  expect(f.db.getRun(admitted.run.id)?.origin).toBe('local_bound')
  const started = await call<{
    dispatchId: string
    state: string
    stage: string
    lastError: string
  }>('orchestration.workerStart', {
    from: 'term_source_coordinator',
    run: admitted.run.id,
    task: admitted.projectionTaskId,
    worktree: 'id:folder:outcome',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    executionBrief: 'Planning only; do not execute outcomes before the source release gate.'
  })
  expect(started).toMatchObject({
    state: 'failed',
    stage: 'terminal_create',
    lastError:
      'Hub-bound execution requires an admitted claim and canonical worker-prepare/worker-execute.'
  })
  expect(f.db.getWorkerDispatch(started.dispatchId)).toMatchObject({ state: 'failed' })
  expect(f.db.getTask(admitted.projectionTaskId)).toMatchObject({
    hub_task_id: 'btk_nativeoutcomes',
    spec: 'btk_nativeoutcomes',
    hub_state_revision: null
  })
  expect(spawn).not.toHaveBeenCalled()
  expect(f.launched).toEqual([])
})
