import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const h = createOrchestrationRpcHarness()
afterEach(() => h.cleanup())

it.each(['missing', 'another Run'])(
  'refuses a task from %s before worker effects',
  async (source) => {
    const { db, runtime, ctx } = h.setup()
    const showTerminal = vi.spyOn(runtime, 'showTerminal')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const createWorktree = vi.spyOn(runtime, 'createManagedWorktree')
    const taskId =
      source === 'missing'
        ? 'task_missing'
        : db.createTask({
            spec: 'Task owned by another coordinator',
            runId: db.createRun({
              objective: 'Other Run',
              coordinatorHandle: 'term_other',
              coordinatorPaneKey: 'tab_other:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
            }).id
          }).id

    await expect(
      h.call('orchestration.workerStart', { task: taskId, from: 'term_coord', agent: 'codex' }, ctx)
    ).rejects.toMatchObject({ code: 'task_not_found' })
    expect(showTerminal).not.toHaveBeenCalled()
    expect(createTerminal).not.toHaveBeenCalled()
    expect(createWorktree).not.toHaveBeenCalled()
  }
)
