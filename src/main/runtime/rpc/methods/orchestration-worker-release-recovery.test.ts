import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileRequestedWorkerTerminalReleases } from '../../orchestration/worker-terminal-release-reconciliation'
import { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcContext } from '../core'
import { ORCHESTRATION_METHODS } from './orchestration'
import * as processTree from '../../orchestration/worker-release-process-tree'
import * as protection from '../../automatic-worker-cleanup-hold'
import * as reviewRelease from '../../../artifacts/artifact-review-worker-release'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('orchestration worker release recovery', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let activeRunId: string

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(protection, 'readAutomaticWorkerCleanupHold').mockResolvedValue(null)
    vi.spyOn(processTree, 'captureWorkerReleaseProcessTree').mockResolvedValue({
      version: 1,
      processIncarnation: 'runtime_test:term_worker:1',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      snapshot: {
        root: { pid: 100, startedAt: 'Thu Oct 1 12:00:00 2026' },
        rootPgid: 100,
        descendants: [{ pid: 101, ppid: 100, pgid: 101, startedAt: 'Thu Oct 1 12:01:00 2026' }],
        capturedAtMs: Date.now()
      }
    })
    vi.spyOn(processTree, 'finishWorkerReleaseProcessTree').mockResolvedValue('exited')
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('live')
    vi.spyOn(runtime, 'resolveConversationCapacityWorkspace').mockResolvedValue('/workspace')
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordinatorPaneKey : handle === 'term_worker' ? workerPaneKey : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? 'runtime_test:term_worker:1' : null
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? ({
            terminalHandle: handle,
            paneKey: workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'local', hostId: 'local' }
          } as never)
        : null
    )
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) => ({ handle, worktreeId: 'repo::worktree', status: 'running' }) as never
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree',
      hostId: 'local'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('omni')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['worker output line 1', 'worker output line 2'],
      truncated: false,
      nextCursor: '2'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: true
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    activeRunId = db.createRun({
      objective: 'Release recovery test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
    ctx = { runtime }
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
    vi.restoreAllMocks()
  })

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  async function startWorker(
    closeOnCompletion: boolean | 'default' = false
  ): Promise<{ taskId: string; dispatchId: string }> {
    if (closeOnCompletion === true || closeOnCompletion === 'default') {
      vi.mocked(runtime.getExactWorkerProviderSession).mockReturnValue({
        paneKey: workerPaneKey,
        processIncarnation: 'runtime_test:term_worker:1',
        agent: 'codex',
        observedAt: Date.now(),
        providerSession: {
          key: 'session_id',
          id: 'session-id',
          transcriptPath: '/profile/.codex/sessions/2026/10/02/rollout.jsonl'
        }
      })
    }
    const task = db.createTask({ spec: 'release recovery fixture task', runId: activeRunId })
    const result = (await call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex',
      ...(closeOnCompletion === 'default' ? {} : { closeOnCompletion })
    })) as { dispatchId: string; state: string }
    expect(result.state).toBe('ready')
    return { taskId: task.id, dispatchId: result.dispatchId }
  }

  async function startSettledWorker(
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ): Promise<{ taskId: string; dispatchId: string }> {
    const worker = await startWorker()
    expect(
      db.settleWorkerReport({
        taskId: worker.taskId,
        dispatchId: worker.dispatchId,
        outcome,
        result: `worker ${outcome}`
      }).action
    ).toBe('settled')
    return worker
  }

  it('retains a requested disposable worker when its owner becomes protected before cleanup', async () => {
    setup()
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'saved result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    vi.mocked(protection.readAutomaticWorkerCleanupHold).mockResolvedValue('routine')
    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result.retained).toBe(1)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'protection_held'
    })
  })

  it('retains a live worker when the coordinator tab is gone instead of wedging its request', async () => {
    setup()
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'saved result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    vi.mocked(protection.readAutomaticWorkerCleanupHold).mockRestore()
    vi.spyOn(runtime, 'getAutomaticCleanupTab').mockReturnValue(null)
    expect(
      await protection.readAutomaticWorkerCleanupHold(runtime, {
        worktreeId: 'repo::worktree',
        paneKey: coordinatorPaneKey
      })
    ).toBe('protection-unknown')
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).retained).toBe(1)
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'protection_held'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('turns an archived pre-close release into retained when protection appears on restart', async () => {
    setup()
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'saved result' })
    const resource = db.requestWorkerTerminalRelease(worker.dispatchId).resource!
    const tree = await processTree.captureWorkerReleaseProcessTree(runtime, resource)
    db.commitWorkerTerminalArchiveForRelease({
      dispatchId: worker.dispatchId,
      resourceId: resource.id,
      kind: 'terminal_tail',
      content: JSON.stringify({ lines: ['saved'], releaseProcessTree: tree }),
      archiveSource: 'terminal',
      archiveStatus: 'captured'
    })
    vi.spyOn(runtime, 'getAutomaticCleanupTab').mockReturnValue({ id: 'tab-worker' } as never)
    vi.mocked(protection.readAutomaticWorkerCleanupHold).mockResolvedValue('pinned')
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).retained).toBe(1)
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
      release_state: 'retained',
      retained_reason: 'protection_held'
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retries accepted cleanup after late mail and refreshes the pre-close archive', async () => {
    setup()
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'saved result' })
    const resource = db.requestWorkerTerminalRelease(worker.dispatchId).resource!
    const tree = await processTree.captureWorkerReleaseProcessTree(runtime, resource)
    const gate = deferred<typeof tree>()
    vi.mocked(processTree.captureWorkerReleaseProcessTree).mockReturnValue(gate.promise)
    const release = reconcileRequestedWorkerTerminalReleases(runtime)
    await vi.waitFor(() =>
      expect(processTree.captureWorkerReleaseProcessTree).toHaveBeenCalledTimes(2)
    )
    const mail = db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${worker.dispatchId}`,
      runId: activeRunId,
      type: 'status',
      subject: 'Follow-up',
      body: 'Please read this.'
    })
    gate.resolve(tree)
    expect((await release).pending).toBe(1)
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
      release_state: 'releasing',
      retained_reason: null
    })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    const delivery = (await call('orchestration.check', {
      terminal: 'term_coord',
      run: activeRunId
    })) as { deliveryId: string; messages: { id: string; to_handle: string }[] }
    expect(delivery.messages).toEqual([
      expect.objectContaining({ id: mail.id, to_handle: `dispatch:${worker.dispatchId}` })
    ])
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).pending).toBe(1)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    vi.spyOn(runtime, 'getAutomaticCleanupTab').mockReturnValue({ id: 'tab-worker' } as never)
    vi.mocked(runtime.readTerminal).mockResolvedValue({
      handle: 'term_worker',
      status: 'running',
      tail: ['Follow-up handled'],
      truncated: false,
      nextCursor: '3'
    })
    await call('orchestration.check', {
      terminal: 'term_coord',
      run: activeRunId,
      ack: delivery.deliveryId
    })
    await vi.waitFor(() =>
      expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('released')
    )
    expect(JSON.parse(db.getWorkerTerminalArchive(worker.dispatchId)!.content).lines).toEqual([
      'Follow-up handled'
    ])
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps descendant cleanup pending after PTY exit and recovers the saved tree after restart', async () => {
    setup()
    const asleep = vi.spyOn(reviewRelease, 'noteReleasedWorkerReviewsAsleep')
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    vi.mocked(processTree.finishWorkerReleaseProcessTree).mockResolvedValueOnce('live')
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).pending).toBe(1)
    expect(asleep).not.toHaveBeenCalled()
    const archive = db.getWorkerTerminalArchive(worker.dispatchId)!
    expect(JSON.parse(archive.content).releaseProcessTree.snapshot.descendants[0].pid).toBe(101)
    expect(JSON.parse(archive.content).resume.execution).toMatchObject({
      worktreeId: 'repo::worktree',
      worktreePath: '/workspace',
      accountHome: '/profile/.codex',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('releasing')
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('Handle disappeared after restart'))
    vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValue('exited')
    vi.mocked(protection.readAutomaticWorkerCleanupHold).mockRestore()
    vi.spyOn(runtime, 'getAutomaticCleanupTab').mockReturnValue(null)
    expect(
      await protection.readAutomaticWorkerCleanupHold(runtime, {
        worktreeId: 'repo::worktree',
        paneKey: workerPaneKey
      })
    ).toBe('protection-unknown')
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).released).toBe(1)
    expect(asleep).toHaveBeenCalledTimes(1)
    expect(processTree.captureWorkerReleaseProcessTree).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('retries a failed review sleep write after exact exit without closing again', async () => {
    setup()
    const asleep = vi
      .spyOn(reviewRelease, 'noteReleasedWorkerReviewsAsleep')
      .mockImplementationOnce(() => {
        throw new Error('Review persistence unavailable')
      })
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).pending).toBe(1)
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('releasing')
    vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValue('exited')
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).released).toBe(1)
    expect(asleep).toHaveBeenCalledTimes(2)
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('rewinds a persisted close phase when a review decision lands after the final hold', async () => {
    setup()
    // The final hold passes; the decision receipt is pinned before the close is sent.
    const hold = vi
      .spyOn(reviewRelease, 'workerReviewReleaseHold')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(
        'A bound review is receiving a decision; keep its execution session available.'
      )
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).pending).toBe(1)
    expect(hold).toHaveBeenCalledTimes(3)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    const resource = db.getWorkerTerminalResourceByOwner(worker.dispatchId)!
    expect(resource.release_state).toBe('releasing')
    expect(db.getWorkerTerminalReleaseClosePhase(worker.dispatchId, resource.id)).toBe('prepared')
    // Keep is still possible, and so is finishing once the decision has been handled.
    expect(db.workerTerminalReleaseCanRetain(resource)).toBe(true)
    hold.mockReturnValue(null)
    vi.spyOn(runtime, 'getAutomaticCleanupTab').mockReturnValue({ id: 'tab-worker' } as never)
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).released).toBe(1)
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('refreshes and persists children born before a live release retry', async () => {
    setup()
    vi.spyOn(runtime, 'getAutomaticCleanupTab').mockReturnValue({ id: 'tab-worker' } as never)
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    vi.mocked(runtime.closeTerminal).mockRejectedValueOnce(new Error('Endpoint unavailable'))
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).pending).toBe(1)
    const old = JSON.parse(
      db.getWorkerTerminalArchive(worker.dispatchId)!.content
    ).releaseProcessTree
    vi.mocked(processTree.captureWorkerReleaseProcessTree).mockResolvedValue({
      ...old,
      snapshot: {
        ...old.snapshot,
        descendants: [{ pid: 102, ppid: 100, pgid: 102, startedAt: 'Thu Oct 1 12:02:00 2026' }]
      }
    })
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).released).toBe(1)
    const saved = JSON.parse(
      db.getWorkerTerminalArchive(worker.dispatchId)!.content
    ).releaseProcessTree
    expect(saved.snapshot.descendants.map((row: { pid: number }) => row.pid)).toEqual([101, 102])
    expect(processTree.finishWorkerReleaseProcessTree).toHaveBeenLastCalledWith(saved)
  })

  it.each(['coordinator', 'worker'] as const)(
    'completes exact saved descendants after PTY exit even when %s tab protection changes',
    async (owner) => {
      setup()
      const worker = await startWorker(true)
      db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'result' })
      db.requestWorkerTerminalRelease(worker.dispatchId)
      vi.mocked(processTree.finishWorkerReleaseProcessTree).mockResolvedValueOnce('live')
      expect((await reconcileRequestedWorkerTerminalReleases(runtime)).pending).toBe(1)
      vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockImplementation(async () => {
        vi.mocked(protection.readAutomaticWorkerCleanupHold).mockImplementation(
          async (_runtime, target) =>
            target.paneKey === (owner === 'coordinator' ? coordinatorPaneKey : workerPaneKey)
              ? 'protected-workspace'
              : null
        )
        return 'exited'
      })
      expect((await reconcileRequestedWorkerTerminalReleases(runtime)).released).toBe(1)
      expect(processTree.finishWorkerReleaseProcessTree).toHaveBeenCalledTimes(2)
      expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('released')
    }
  )

  it('does not close a disposable worker whose provider account cannot be saved', async () => {
    setup()
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    vi.mocked(runtime.getExactWorkerProviderSession).mockReturnValue(null)
    expect((await reconcileRequestedWorkerTerminalReleases(runtime)).pending).toBe(1)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('releases accepted completions after coordinator acknowledgment, never on report or read', async () => {
    setup()
    const asleep = vi.spyOn(reviewRelease, 'noteReleasedWorkerReviewsAsleep')
    const { taskId, dispatchId } = await startWorker(true)
    const report = db.insertMessage({
      from: 'term_worker',
      senderPaneKey: workerPaneKey,
      runId: activeRunId,
      to: `run:${activeRunId}`,
      type: 'worker_done',
      subject: 'Complete',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    })
    expect(reconcileLifecycleMessage(db, report).action).toBe('completed')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    const delivery = (await call('orchestration.check', {
      terminal: 'term_coord',
      run: activeRunId
    })) as { deliveryId: string }
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    await call('orchestration.check', {
      terminal: 'term_coord',
      run: activeRunId,
      ack: delivery.deliveryId
    })
    await vi.waitFor(() => {
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    })
    expect(runtime.closeTerminal).toHaveBeenCalledExactlyOnceWith('term_worker')
    expect(asleep).toHaveBeenCalledTimes(1)
    await expect(call('orchestration.workerRead', { dispatch: dispatchId })).resolves.toMatchObject(
      {
        archived: true,
        terminal: { tail: ['worker output line 1', 'worker output line 2'] }
      }
    )
  })

  it('defaults an unstamped local folder worker to accepted-completion cleanup', async () => {
    setup()
    vi.mocked(runtime.showManagedTerminalWorkspace).mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo',
      connectionId: null,
      executionHostId: null
    } as never)
    const { dispatchId } = await startWorker('default')
    expect(runtime.showRepo).toHaveBeenCalledWith('id:repo')
    expect(
      JSON.parse(db.getWorkerDispatch(dispatchId)!.start_options).completionPolicy
    ).toMatchObject({
      kind: 'release_on_accepted_completion'
    })
  })

  it.each(['succeeded', 'failed'] as const)(
    'defaults a new local Codex worker to durable accepted %s release',
    async (outcome) => {
      setup()
      const { taskId, dispatchId } = await startWorker('default')
      expect(
        JSON.parse(db.getWorkerDispatch(dispatchId)!.start_options).completionPolicy
      ).toMatchObject({
        kind: 'release_on_accepted_completion'
      })
      const report = db.insertMessage({
        from: 'term_worker',
        senderPaneKey: workerPaneKey,
        runId: activeRunId,
        to: `run:${activeRunId}`,
        type: 'worker_done',
        subject: 'Complete',
        payload: JSON.stringify({ taskId, dispatchId, outcome })
      })
      expect(reconcileLifecycleMessage(db, report).action).toBe(
        outcome === 'succeeded' ? 'completed' : 'failed'
      )
      const delivery = (await call('orchestration.check', {
        terminal: 'term_coord',
        run: activeRunId
      })) as { deliveryId: string }
      expect(runtime.closeTerminal).not.toHaveBeenCalled()
      await call('orchestration.check', {
        terminal: 'term_coord',
        run: activeRunId,
        ack: delivery.deliveryId
      })
      await vi.waitFor(() => {
        expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      })
      expect(db.getWorkerTerminalArchive(dispatchId)).toBeDefined()
      expect(runtime.closeTerminal).toHaveBeenCalledExactlyOnceWith('term_worker')
    }
  )

  it('keeps a default worker when its actual pane becomes protected before dispatch', async () => {
    setup()
    vi.mocked(protection.readAutomaticWorkerCleanupHold).mockImplementation(
      async (_runtime, target) => (target.paneKey === workerPaneKey ? 'pinned' : null)
    )
    const { dispatchId } = await startWorker('default')
    expect(
      JSON.parse(db.getWorkerDispatch(dispatchId)!.start_options).completionPolicy
    ).toBeUndefined()
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('not_requested')
  })

  it('does not persist the default policy before the actual spawned-pane check resolves', async () => {
    setup()
    const gate = deferred<string | null>()
    vi.mocked(protection.readAutomaticWorkerCleanupHold).mockImplementation(
      async (_runtime, target) => (target.paneKey === workerPaneKey ? gate.promise : null)
    )
    const task = db.createTask({ spec: 'launch window', runId: activeRunId })
    const start = call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'codex'
    })
    await vi.waitFor(() =>
      expect(protection.readAutomaticWorkerCleanupHold).toHaveBeenCalledWith(
        runtime,
        { worktreeId: 'repo::worktree', paneKey: workerPaneKey },
        { questionWait: true }
      )
    )
    await vi.waitFor(() => {
      const row = db.db.prepare('SELECT start_options FROM worker_dispatches LIMIT 1').get() as
        | { start_options: string }
        | undefined
      expect(row).toBeDefined()
      expect(JSON.parse(row!.start_options).completionPolicy).toBeUndefined()
    })
    gate.resolve(null)
    const started = (await start) as { dispatchId: string }
    expect(
      JSON.parse(db.getWorkerDispatch(started.dispatchId)!.start_options).completionPolicy
    ).toMatchObject({ kind: 'release_on_accepted_completion' })
  })

  it('keeps a default worker after durable user retention and accepted completion', async () => {
    setup()
    const { taskId, dispatchId } = await startWorker('default')
    await expect(
      call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({
      state: 'retained',
      reason: 'user_requested'
    })
    const report = db.insertMessage({
      from: 'term_worker',
      senderPaneKey: workerPaneKey,
      runId: activeRunId,
      to: `run:${activeRunId}`,
      type: 'worker_done',
      subject: 'Complete',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    })
    expect(reconcileLifecycleMessage(db, report).action).toBe('completed')
    const delivery = (await call('orchestration.check', {
      terminal: 'term_coord',
      run: activeRunId
    })) as { deliveryId: string }
    await call('orchestration.check', {
      terminal: 'term_coord',
      run: activeRunId,
      ack: delivery.deliveryId
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('retained')
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('reads an immutable transcript snapshot after the provider file disappears', async () => {
    setup()
    const directory = await mkdtemp(join(tmpdir(), 'omni-worker-release-snapshot-'))
    const transcriptPath = join(directory, 'rollout.jsonl')
    try {
      await writeFile(
        transcriptPath,
        `${JSON.stringify({
          timestamp: '2026-08-03T12:00:00.000Z',
          type: 'event_msg',
          payload: { id: 'snapshot-message', type: 'agent_message', message: 'frozen output' }
        })}\n`
      )
      vi.mocked(runtime.getExactWorkerProviderSession).mockReturnValue({
        agent: 'codex',
        paneKey: workerPaneKey,
        processIncarnation: 'runtime_test:term_worker:1',
        providerSession: {
          key: 'codex:snapshot-session',
          id: 'snapshot-session',
          transcriptPath
        }
      } as never)
      const { dispatchId } = await startSettledWorker()
      await call('orchestration.workerRelease', { dispatch: dispatchId })
      await rm(transcriptPath)

      await expect(
        call('orchestration.workerRead', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        archived: true,
        source: 'transcript',
        resume: {
          agent: 'codex',
          providerSessionId: 'snapshot-session',
          providerSessionKey: 'codex:snapshot-session',
          transcriptPath,
          processIncarnation: 'runtime_test:term_worker:1'
        },
        transcript: {
          messages: [{ id: 'snapshot-message', blocks: [{ type: 'text', text: 'frozen output' }] }]
        }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('finishes a requested release after restart-style interruption', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockRejectedValueOnce(new Error('Multiplexer disposed'))
    const interrupted = (await call('orchestration.workerRelease', { dispatch: dispatchId })) as {
      state: string
    }
    expect(interrupted.state).toBe('release_pending')
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')

    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result).toMatchObject({ attempted: 1, released: 1 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
  })

  it('defers instead of settling unknown while inventory is incomplete', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockRejectedValueOnce(new Error('Multiplexer disposed'))
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))

    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result).toMatchObject({ attempted: 1, pending: 1, unknown: 0 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
  })

  it('preserves archived output when an unconfirmed release retry cannot find the terminal', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    vi.mocked(runtime.closeTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its SSH provider is no longer registered'
    })

    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown' })
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeDefined()

    vi.mocked(runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    await expect(
      call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'release_unknown' })
    const read = (await call('orchestration.workerRead', { dispatch: dispatchId })) as {
      archived?: boolean
      terminal: { tail: string[] }
    }
    expect(read).toMatchObject({
      archived: true,
      terminal: { tail: ['worker output line 1', 'worker output line 2'] }
    })
  })

  it('reconciles an unknown issued close only after exact PTY and descendant exit, then saves sleep', async () => {
    setup()
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'saved result' })
    vi.mocked(runtime.closeTerminal).mockResolvedValueOnce({
      handle: 'term_worker',
      tabId: 'tab-worker',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable'
    })
    expect(
      await call('orchestration.workerRelease', { dispatch: worker.dispatchId })
    ).toMatchObject({ state: 'release_unknown' })
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('unknown')
    const sleep = vi.spyOn(reviewRelease, 'noteReleasedWorkerReviewsAsleep')
    const settle = vi.spyOn(db, 'settleWorkerTerminalRelease')
    vi.spyOn(runtime, 'getAutomaticCleanupTab').mockReturnValue(null)
    for (const verdict of ['live', 'unverifiable'] as const) {
      vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValue(verdict)
      expect(await reconcileRequestedWorkerTerminalReleases(runtime)).toMatchObject({
        attempted: 1,
        pending: 1
      })
      expect(sleep).not.toHaveBeenCalled()
      expect(settle).not.toHaveBeenCalled()
    }
    vi.mocked(runtime.inspectTerminalProcessIncarnationLiveness).mockResolvedValue('exited')
    vi.mocked(processTree.finishWorkerReleaseProcessTree).mockResolvedValue('unverifiable')
    expect(await reconcileRequestedWorkerTerminalReleases(runtime)).toMatchObject({
      attempted: 1,
      pending: 1
    })
    expect(sleep).not.toHaveBeenCalled()
    vi.mocked(processTree.finishWorkerReleaseProcessTree).mockResolvedValue('exited')
    sleep.mockImplementationOnce(() => {
      throw new Error('sleep store unavailable')
    })
    expect(await reconcileRequestedWorkerTerminalReleases(runtime)).toMatchObject({
      attempted: 1,
      pending: 1
    })
    expect(settle).not.toHaveBeenCalled()
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('unknown')
    expect(await reconcileRequestedWorkerTerminalReleases(runtime)).toMatchObject({
      attempted: 1,
      released: 1
    })
    expect(settle).toHaveBeenCalledTimes(1)
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.release_state).toBe('released')
  })

  it('leaves prepared and non-owned unknown resources outside automatic close recovery', async () => {
    setup()
    const worker = await startWorker(true)
    db.settleWorkerReport({ ...worker, outcome: 'succeeded', result: 'saved result' })
    db.requestWorkerTerminalRelease(worker.dispatchId)
    const resource = db.getWorkerTerminalResourceByOwner(worker.dispatchId)!
    db.markWorkerTerminalReleaseUnknown(resource.id, 'no issued close')
    vi.spyOn(db, 'getWorkerTerminalReleaseClosePhase').mockReturnValue('prepared')
    expect(await reconcileRequestedWorkerTerminalReleases(runtime)).toMatchObject({ attempted: 0 })
    db.db
      .prepare("UPDATE worker_terminal_resources SET ownership_state = 'user_owned' WHERE id = ?")
      .run(resource.id)
    expect(await reconcileRequestedWorkerTerminalReleases(runtime)).toMatchObject({ attempted: 0 })
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('never touches resources without requested releases', async () => {
    setup()
    await startSettledWorker()
    const result = await reconcileRequestedWorkerTerminalReleases(runtime)
    expect(result.attempted).toBe(0)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('coalesces overlapping reconciliation passes and closes each resource once', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    expect(db.requestWorkerTerminalRelease(dispatchId).disposition).toBe('requested')
    const pendingClose = deferred<Awaited<ReturnType<OrcaRuntimeService['closeTerminal']>>>()
    vi.mocked(runtime.closeTerminal).mockReturnValue(pendingClose.promise)

    const first = reconcileRequestedWorkerTerminalReleases(runtime)
    await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledTimes(1))
    const second = reconcileRequestedWorkerTerminalReleases(runtime)
    expect(second).toBe(first)
    pendingClose.resolve({ handle: 'term_worker', tabId: 'tab-worker', ptyKilled: true })

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ attempted: 1, released: 1 }),
      expect.objectContaining({ attempted: 1, released: 1 })
    ])
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps live terminals bounded across 50 settled workers while controls survive', async () => {
    setup()
    for (let wave = 0; wave < 50; wave += 1) {
      const worker = await startSettledWorker(wave % 2 === 0 ? 'succeeded' : 'failed')
      const receipt = (await call('orchestration.workerRelease', {
        dispatch: worker.dispatchId
      })) as { state: string }
      expect(receipt.state).toBe('released')
    }
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(50)

    const control = await startWorker()
    const listed = (await call('orchestration.workerList', { run: activeRunId })) as {
      workers: { dispatchId: string; terminalState: string | null }[]
      counts: Record<string, number>
    }
    expect(listed.counts).toMatchObject({ released: 50, active: 1 })
    expect(
      listed.workers.find((worker) => worker.dispatchId === control.dispatchId)?.terminalState
    ).toBe('active')
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(50)
  })

  it('removes terminal authority and archived output on orchestration reset', async () => {
    setup()
    const { dispatchId } = await startSettledWorker()
    await call('orchestration.workerRelease', { dispatch: dispatchId })
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeDefined()

    db.resetTasks()

    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toBeUndefined()
    expect(db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })
})
