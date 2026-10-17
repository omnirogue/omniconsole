import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const harness = createOrchestrationRpcHarness()
const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
})

function ownedWorker() {
  const state = harness.setup()
  const task = state.db.createTask({ spec: 'Retain the current worker' })
  const dispatch = state.db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_worker',
    assigneePaneKey: workerPaneKey,
    processIncarnation: 'runtime_test:term_worker:1',
    creator: { kind: 'system' },
    maxDepth: 1
  })
  state.db.completeDispatch(dispatch.id)
  const resource = state.db.createWorkerTerminalResourceStatement({
    dispatchId: dispatch.id,
    worktreeId: null,
    terminalHandle: 'term_worker',
    paneKey: workerPaneKey,
    processIncarnation: 'runtime_test:term_worker:1',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    ownership: 'owned'
  })
  vi.spyOn(state.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_worker' ? workerPaneKey : harness.coordinatorPaneKey
  )
  return { ...state, dispatch, resource }
}

describe('orchestration.workerRetain expected identity', () => {
  it('rejects a process replacement in the same pane without retaining its historical resource', async () => {
    const state = ownedWorker()
    vi.spyOn(state.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:replacement' : null
    )
    await expect(
      harness.call(
        'orchestration.workerRetain',
        {
          dispatch: state.dispatch.id,
          expectedPaneKey: state.resource.pane_key,
          expectedProcessIncarnation: state.resource.process_incarnation
        },
        state.ctx
      )
    ).resolves.toMatchObject({ state: 'retained', reason: 'identity_unproven' })
    expect(state.db.getWorkerTerminalResource(state.resource.id)?.release_state).toBe(
      'not_requested'
    )
  })

  it('retains only when pane and process identity still match', async () => {
    const state = ownedWorker()
    await expect(
      harness.call(
        'orchestration.workerRetain',
        {
          dispatch: state.dispatch.id,
          expectedPaneKey: state.resource.pane_key,
          expectedProcessIncarnation: state.resource.process_incarnation
        },
        state.ctx
      )
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(state.db.getWorkerTerminalResource(state.resource.id)?.release_state).toBe('retained')
  })
})
