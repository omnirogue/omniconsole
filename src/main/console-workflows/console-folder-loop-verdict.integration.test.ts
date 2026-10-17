import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsoleJobResultGate } from './console-job-result-gate'
import { monitorConsoleJob } from './console-job-monitor'
import { listConsoleLocalExecutions } from './console-local-execution-state'
import { createConsoleLocalExecutionFixture } from './console-local-execution-test-fixture'

describe('folder loop verdict finalization', () => {
  let f: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>

  beforeEach(async () => {
    f = await createConsoleLocalExecutionFixture({ workspaceKind: 'folder' })
    f.job.action = 'review'
    f.job.readOnly = true
    f.job.ownedPaths = ['workflow-loops/review-current/**']
    f.job.inputs = [
      {
        loop_stage: { key: 'review-current', role: 'review', round: 1 },
        producer: null
      }
    ]
  })

  afterEach(async () => {
    f.service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.db.close()
    vi.restoreAllMocks()
    await rm(f.directory, { recursive: true, force: true })
  })

  async function settled() {
    const started = await f.service.start({
      jobId: f.job.id,
      workflowId: f.job.workflowId,
      approvedDigest: f.job.digest,
      worktree: 'id:folder:local-fixture'
    })
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    f.service.dispose()
    vi.mocked(f.port.inspect).mockResolvedValue({ ok: true, data: { cancelled: false } })
    const record = listConsoleLocalExecutions(f.db, (await f.port.principal())!)[0]!
    const task = f.db.getDispatchContextById(record.worker.dispatch_id)!
    f.db.settleWorkerReport({
      taskId: task.task_id,
      dispatchId: record.worker.dispatch_id,
      outcome: 'succeeded',
      result: 'Folder review finished'
    })
    f.db.insertMessage({
      runId: record.run.id,
      from: record.worker.agent_terminal_handle!,
      to: `run:${record.run.id}`,
      type: 'worker_done',
      subject: 'Folder review evidence',
      body: 'Reviewed the selected folder snapshot.',
      payload: JSON.stringify({
        taskId: task.task_id,
        dispatchId: record.worker.dispatch_id,
        outcome: 'succeeded'
      })
    })
    f.exitGate(0)
    const ctx = {
      runtime: f.runtime,
      port: f.port,
      results: f.journal,
      resultGate: new ConsoleJobResultGate(),
      call: vi.fn().mockResolvedValue({}),
      cancel: vi.fn()
    }
    return { ctx, record }
  }

  it('publishes the strict canonical verdict with the selected folder snapshot result', async () => {
    const root = join(f.cwd, 'workflow-loops/review-current')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'verdict.json'),
      JSON.stringify({ verdict: 'agree', blockers: [], gaps: [], notes: 'Folder is correct.' })
    )
    const { ctx, record } = await settled()
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.journal.read(record.worker.dispatch_id)).toMatchObject({
      status: 'done',
      candidate_sha: null,
      workflow_loop_verdict: {
        verdict: 'agree',
        blockers: [],
        gaps: [],
        notes: 'Folder is correct.'
      }
    })
    expect(f.port.publishFolderArtifact).toHaveBeenCalledOnce()
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
  })

  it('refuses a loop reviewer whose handoff admits no verdict directory before any hub claim', async () => {
    f.job.ownedPaths = null
    const started = await f.service.start({
      jobId: f.job.id,
      workflowId: f.job.workflowId,
      approvedDigest: f.job.digest,
      worktree: 'id:folder:local-fixture'
    })
    expect(started).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining('no single canonical verdict directory'),
        launchDisposition: 'not-started'
      }
    })
    expect(f.port.activate).not.toHaveBeenCalled()
    expect(listConsoleLocalExecutions(f.db, (await f.port.principal())!)).toHaveLength(0)
  })

  it.each([null, [], ['a/**', 'b/**'], ['../escape/**']])(
    'records and releases a failed review instead of throwing when a running attempt owns %j',
    async (ownedPaths) => {
      const { ctx, record } = await settled()
      record.attempt.job.ownedPaths = ownedPaths
      await monitorConsoleJob(ctx, record, new AbortController().signal)
      const result = f.journal.read(record.worker.dispatch_id)!
      expect(result).toMatchObject({
        status: 'failed',
        output_tail: expect.stringContaining('no single canonical verdict directory')
      })
      expect(result).not.toHaveProperty('workflow_loop_verdict')
      expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
        dispatch: record.worker.dispatch_id
      })
      await monitorConsoleJob(ctx, record, new AbortController().signal)
      expect(f.journal.record).toHaveBeenCalledOnce()
    }
  )

  it.each(['missing', 'malformed'] as const)(
    'records and releases a failed folder review when its verdict is %s',
    async (kind) => {
      if (kind === 'malformed') {
        const root = join(f.cwd, 'workflow-loops/review-current')
        await mkdir(root, { recursive: true })
        await writeFile(join(root, 'verdict.json'), '{"verdict":"pass"}')
      }
      const { ctx, record } = await settled()
      await monitorConsoleJob(ctx, record, new AbortController().signal)
      const result = f.journal.read(record.worker.dispatch_id)!
      expect(result).toMatchObject({
        status: 'failed',
        candidate_sha: null,
        output_tail: expect.stringContaining('canonical loop verdict file is missing or malformed')
      })
      expect(result).not.toHaveProperty('workflow_loop_verdict')
      expect(f.port.publishFolderArtifact).toHaveBeenCalledOnce()
      expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
        dispatch: record.worker.dispatch_id
      })
    }
  )
})
