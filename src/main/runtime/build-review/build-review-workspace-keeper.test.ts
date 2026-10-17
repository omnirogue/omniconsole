import { describe, expect, it, vi } from 'vitest'
import type {
  BuildReviewPipelineSnapshot,
  BuildReviewWorkspaceHold
} from '../../../shared/build-review-pipeline'
import type { OrcaRuntimeService } from '../omni-runtime'
import { createPipelineSnapshot } from './build-review-pipeline-state'
import type { OrchestrationCaller } from './build-review-rpc-call'
import type { UnresolvedBuildReviewDispatch } from './build-review-workspace-evidence'
import { BuildReviewWorkspaceKeeper } from './build-review-workspace-keeper'
import type * as ReconcileModule from './build-review-workspace-reconcile'
import type { BuildReviewHoldFacts } from './build-review-workspace-reconcile'

const reconcile = vi.hoisted(() => ({
  releaseSettled: vi.fn(async (): Promise<unknown> => null)
}))
vi.mock('./build-review-workspace-reconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof ReconcileModule>()),
  releaseSettledBuildReviewWorkspace: reconcile.releaseSettled
}))
vi.mock('./build-review-workspace-reservation', () => ({
  buildReviewWorkspaceKey: () => 'local-workspace',
  releaseBuildReviewWorkspace: vi.fn(() => false),
  clearRejectedBuildReviewWorkerStart: vi.fn(),
  ownerDefinitelyGone: vi.fn(() => true)
}))

const HOLD: BuildReviewWorkspaceHold = {
  pipelineId: 'brp_held',
  runId: 'run_1',
  items: [{ kind: 'terminal-open', role: 'builder', dispatchId: 'ctx_1', terminalHandle: 'term_1' }]
}

const OPEN_TERMINAL: UnresolvedBuildReviewDispatch = {
  id: 'ctx_1',
  kind: 'terminal-open',
  terminalHandle: 'term_1',
  processIncarnation: null,
  hostScope: null,
  terminalReleased: false,
  mayBeWorking: false,
  releasable: false
}

function holdFacts(open: UnresolvedBuildReviewDispatch[]): BuildReviewHoldFacts {
  return {
    reservation: { pipeline_id: 'brp_held', run_id: 'run_1' },
    open,
    missingEvidence: false,
    owner: null
  } as unknown as BuildReviewHoldFacts
}

function heldRun(): BuildReviewPipelineSnapshot {
  const pipeline = createPipelineSnapshot({ worktree: 'id:repo::/wt', objective: 'Fix it' })
  pipeline.id = 'brp_held'
  pipeline.stage = 'failed'
  pipeline.builder.terminalHandle = 'term_1'
  pipeline.workspaceHold = structuredClone(HOLD)
  return pipeline
}

function setup(pipelines: BuildReviewPipelineSnapshot[]) {
  const exitListeners = new Map<string, () => void>()
  /** What the runtime says about the terminal once it exits: kept readable, with its exit. */
  const terminal: Record<string, unknown> = { ptyId: 'pty_1' }
  const runtime = {
    getOrchestrationDb: () => ({}),
    getRuntimeId: () => 'runtime_1',
    showManagedTerminalWorkspace: vi.fn(async () => ({ id: 'repo::/wt', path: '/wt' })),
    subscribeToPtyExit: vi.fn((ptyId: string, listener: () => void) => {
      exitListeners.set(ptyId, listener)
      return () => exitListeners.delete(ptyId)
    })
  }
  const call = vi.fn(async (method: string) =>
    method === 'terminal.show' ? { terminal: { ...terminal } } : {}
  ) as unknown as OrchestrationCaller
  const changed = vi.fn()
  const keeper = new BuildReviewWorkspaceKeeper({
    runtime: runtime as unknown as OrcaRuntimeService,
    call,
    pipelines: new Map(pipelines.map((pipeline) => [pipeline.id, pipeline])),
    isActive: () => false,
    changed
  })
  const close = () => {
    Object.assign(terminal, { connected: false, exitCause: { kind: 'operator_close' } })
    exitListeners.get('pty_1')!()
  }
  return { keeper, runtime, call, changed, exitListeners, close }
}

describe('BuildReviewWorkspaceKeeper', () => {
  it('frees the workspace the moment the terminal a hold names is closed', async () => {
    // Why typed: a plain `= null` would narrow the hold to null for the whole test.
    const pipeline: BuildReviewPipelineSnapshot = { ...heldRun(), workspaceHold: null }
    const { keeper, runtime, changed, close } = setup([pipeline])
    reconcile.releaseSettled.mockResolvedValueOnce(holdFacts([OPEN_TERMINAL]))
    await keeper.release(pipeline)
    expect(pipeline.workspaceHold?.items).toMatchObject([{ terminalHandle: 'term_1' }])
    await vi.waitFor(() => expect(runtime.subscribeToPtyExit).toHaveBeenCalledTimes(1))
    expect(runtime.subscribeToPtyExit.mock.calls[0]![0]).toBe('pty_1')

    changed.mockClear()
    reconcile.releaseSettled.mockResolvedValueOnce(null)
    close()
    await vi.waitFor(() => expect(pipeline.workspaceHold).toBeNull())
    expect(reconcile.releaseSettled).toHaveBeenLastCalledWith(
      expect.anything(),
      'local-workspace',
      'observe'
    )
    // Nothing offers to open the closed terminal any more, and the run says it is free.
    expect(pipeline.builder.terminalClosed).toBe(true)
    expect(pipeline.events.at(-1)?.text).toBe('Workspace released')
    expect(changed).toHaveBeenCalledWith(pipeline)
  })

  it('keeps offering a terminal whose exit the runtime cannot vouch for', async () => {
    const pipeline = heldRun()
    const { keeper, runtime, exitListeners } = setup([pipeline])
    keeper.record(pipeline, holdFacts([OPEN_TERMINAL]))
    await vi.waitFor(() => expect(runtime.subscribeToPtyExit).toHaveBeenCalledTimes(1))
    reconcile.releaseSettled.mockClear()
    // An exit event with the terminal still answering as connected: a stop nobody confirmed.
    exitListeners.get('pty_1')!()
    await vi.waitFor(() => expect(reconcile.releaseSettled).toHaveBeenCalledTimes(1))
    expect(pipeline.builder.terminalClosed).toBeUndefined()
  })

  it('watches each named terminal once, however often the hold is recorded', async () => {
    const pipeline = heldRun()
    const { keeper, call, runtime } = setup([pipeline])
    for (let index = 0; index < 3; index += 1) {
      keeper.record(pipeline, holdFacts([OPEN_TERMINAL]))
      keeper.record(pipeline, null)
    }
    await vi.waitFor(() => expect(runtime.subscribeToPtyExit).toHaveBeenCalledTimes(1))
    const shows = vi.mocked(call).mock.calls.filter(([method]) => method === 'terminal.show')
    expect(shows).toEqual([['terminal.show', { terminal: 'term_1' }]])
  })

  it('looks again at a restored run the first time it is shown, and only then', async () => {
    const pipeline = heldRun()
    const { keeper, changed } = setup([pipeline])
    reconcile.releaseSettled.mockClear()
    reconcile.releaseSettled.mockResolvedValue(null)
    expect(keeper.refreshRestored(pipeline)).toBe(pipeline)
    await vi.waitFor(() => expect(pipeline.workspaceHold).toBeNull())
    expect(changed).toHaveBeenCalledWith(pipeline)
    keeper.refreshRestored(pipeline)
    expect(reconcile.releaseSettled).toHaveBeenCalledTimes(1)
  })

  it('drops a refresh whose answer lands after a newer one was recorded', async () => {
    const pipeline = heldRun()
    const { keeper } = setup([pipeline])
    let answer!: (facts: unknown) => void
    reconcile.releaseSettled.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    )
    const refreshing = keeper.refresh(pipeline)
    await vi.waitFor(() => expect(answer).toBeDefined())
    const newer = { ...structuredClone(HOLD), runId: 'run_newer' }
    pipeline.workspaceHold = newer
    answer(null)
    await refreshing
    expect(pipeline.workspaceHold).toBe(newer)
  })
})
