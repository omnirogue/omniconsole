import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import * as reviews from './console-job-review'
import { ConsoleJobResultGate } from './console-job-result-gate'
import { monitorConsoleJob } from './console-job-monitor'
import { listConsoleLocalExecutions } from './console-local-execution-state'
import { createConsoleLocalExecutionFixture } from './console-local-execution-test-fixture'

describe('Git execution evidence for independent task verification', () => {
  let f: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>
  beforeEach(async () => {
    f = await createConsoleLocalExecutionFixture()
    f.job.acceptanceCommands = []
    f.job.artifactResult = { path: 'work-result.json', format: 'json', maxBytes: 65536 }
    vi.spyOn(reviews, 'publishConsoleJobReview').mockRejectedValue(
      new Error('Artifact execution must not invent PR publication.')
    )
  })
  afterEach(async () => {
    f.service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.db.close()
    vi.restoreAllMocks()
    await rm(f.directory, { recursive: true, force: true })
  })
  async function prepared(
    options: { report?: boolean; reportBody?: string; succeeded?: boolean; exitCode?: number } = {}
  ) {
    const started = await f.service.start({
      jobId: f.job.id,
      workflowId: f.job.workflowId,
      approvedDigest: f.job.digest,
      worktree: 'id:source'
    })
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    if (f.job.artifactResult) {
      const prompt = vi.mocked(f.runtime.sendTerminalAgentPrompt).mock.calls[0]![1]
      if (!f.job.readOnly) {
        expect(prompt).toContain('does not create a pull request')
      }
      expect(prompt).not.toContain('the IDE will run acceptance and publish')
    }
    f.service.dispose()
    vi.mocked(f.port.inspect).mockResolvedValue({ ok: true, data: { cancelled: false } })
    const record = listConsoleLocalExecutions(f.db, (await f.port.principal())!)[0]!
    const dispatchId = record.worker.dispatch_id
    const taskId = f.db.getDispatchContextById(dispatchId)!.task_id
    const outcome = options.succeeded === false ? 'failed' : 'succeeded'
    f.db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome,
      result: 'Implementation stage finished'
    })
    if (options.report !== false) {
      f.db.insertMessage({
        runId: record.run.id,
        from: record.worker.agent_terminal_handle!,
        to: `run:${record.run.id}`,
        type: 'worker_done',
        subject: 'Stage evidence',
        body:
          options.reportBody ?? 'Implementation prepared; reviews and delivery remain unverified.',
        payload: JSON.stringify({ taskId, dispatchId, outcome })
      })
    }
    f.exitGate(options.exitCode ?? 0)
    const ctx = {
      runtime: f.runtime,
      port: f.port,
      results: f.journal,
      resultGate: new ConsoleJobResultGate(),
      call: vi.fn().mockResolvedValue({}),
      cancel: vi.fn()
    }
    const git = (args: string[]) => gitExecFileAsync(args, { cwd: record.attempt.worktreePath })
    return { record, ctx, git }
  }
  it('retains real committed bytes/head, report and physical exit without publishing or claiming task completion', async () => {
    const { record, ctx, git } = await prepared()
    await writeFile(join(record.attempt.worktreePath, 'README.md'), 'Implemented result\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'implemented stage'])
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    const result = f.journal.read(record.worker.dispatch_id)!
    expect(result).toMatchObject({
      status: 'done',
      candidate_sha: head,
      changed_files: ['README.md'],
      pr_url: null,
      pr_number: null,
      result_exit_code: 0,
      owned_paths_violations: [],
      worker_report: 'Implementation prepared; reviews and delivery remain unverified.',
      terminal_proof: { kind: 'exited', process_exit_code: 0 }
    })
    expect(result.output_tail).toContain(
      'original task acceptance requires independent verification'
    )
    const upload = vi.mocked(f.port.publishFolderArtifact!).mock.calls[0]![0]
    expect(JSON.parse(Buffer.from(upload.contentBase64, 'base64').toString())).toMatchObject({
      candidate_sha: head,
      branch: record.attempt.branch,
      changed_files: ['README.md'],
      worker_report: result.worker_report,
      terminal_proof: result.terminal_proof
    })
    expect(reviews.publishConsoleJobReview).not.toHaveBeenCalled()
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.port.publishFolderArtifact).toHaveBeenCalledOnce()
    expect(f.journal.record).toHaveBeenCalledOnce()
  })
  it('records and releases a failed loop review when its canonical verdict file is missing', async () => {
    f.job.action = 'review'
    f.job.readOnly = true
    f.job.ownedPaths = ['workflow-loops/review-1/**']
    f.job.inputs = [
      {
        loop_stage: { key: 'review-1', role: 'review', round: 1 },
        producer: {
          key: 'producer',
          job_id: 'job_producer',
          candidate_sha: f.job.baseSha
        }
      }
    ]
    const { record, ctx } = await prepared()
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.journal.read(record.worker.dispatch_id)).toMatchObject({
      status: 'failed',
      output_tail: expect.stringContaining('canonical loop verdict file is missing or malformed')
    })
    expect(f.journal.read(record.worker.dispatch_id)).not.toHaveProperty('workflow_loop_verdict')
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
  })
  it('ignores only untracked host run metadata in a repository without a gitignore', async () => {
    const { record, ctx, git } = await prepared()
    const root = record.attempt.worktreePath
    await mkdir(join(root, '.omni/runs/chain'), { recursive: true })
    await writeFile(join(root, '.omni/runs/chain/report.json'), '{"host":"runtime"}')
    await writeFile(join(root, 'README.md'), 'Committed deliverable')
    await git(['add', 'README.md'])
    await git(['commit', '-m', 'deliverable'])
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.journal.read(record.worker.dispatch_id)).toMatchObject({
      status: 'done',
      changed_files: ['README.md'],
      owned_paths_violations: []
    })
    expect((await git(['status', '--porcelain'])).stdout).toContain('?? .omni/')
  })

  it.each(['staged', 'tracked', 'declared', 'unrelated', 'credential'] as const)(
    'keeps %s paths inside the candidate and evidence boundary',
    async (kind) => {
      const runtimePath = '.omni/runs/report.json'
      if (kind === 'declared' || kind === 'credential') {
        f.job.ownedPaths = ['README.md', runtimePath]
      }
      const { record, ctx, git } = await prepared()
      const file = kind === 'unrelated' ? 'untracked-source.ts' : runtimePath
      await mkdir(join(record.attempt.worktreePath, '.omni/runs'), { recursive: true })
      await writeFile(
        join(record.attempt.worktreePath, file),
        kind === 'credential' ? 'opaque-bearer-sentinel' : 'candidate data'
      )
      if (['staged', 'tracked', 'credential'].includes(kind)) {
        await git(['add', file])
      }
      if (['tracked', 'credential'].includes(kind)) {
        await git(['commit', '-m', 'tracked candidate'])
      }
      await monitorConsoleJob(ctx, record, new AbortController().signal)
      const result = f.journal.read(record.worker.dispatch_id)!
      expect(result.status).toBe('failed')
      expect(result.changed_files).toContain(file)
      if (kind === 'credential') {
        expect(result.output_tail).toContain('credential inspection')
        expect(JSON.stringify(result)).not.toContain('opaque-bearer-sentinel')
      } else if (kind === 'declared') {
        expect(result.owned_paths_violations).toEqual([])
        expect(result.output_tail).toContain('Commit repository changes')
      } else {
        expect(result.owned_paths_violations).toContain(file)
      }
    }
  )

  it('records large committed scope violations with bounded truthful artifact path evidence', async () => {
    const reportBody = 'x'.repeat(32_000)
    const { record, ctx, git } = await prepared({ reportBody })
    const paths = Array.from(
      { length: 500 },
      (_, index) => `${String(index).padStart(4, '0')}-${'long-path-'.repeat(22)}.txt`
    )
    await Promise.all(paths.map((file) => writeFile(join(record.attempt.worktreePath, file), 'x')))
    await git(['add', '.'])
    await git(['commit', '-m', 'large out-of-scope candidate'])
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    const result = f.journal.read(record.worker.dispatch_id)!
    expect(result.status).toBe('failed')
    expect(result.changed_files).toEqual(paths)
    expect(result.owned_paths_violations).toEqual(paths)
    const uploaded = vi.mocked(f.port.publishFolderArtifact!).mock.calls[0]![0]
    const bytes = Buffer.from(uploaded.contentBase64, 'base64')
    expect(bytes.length).toBeLessThanOrEqual(65_536)
    const artifact = JSON.parse(bytes.toString())
    expect(artifact).toMatchObject({
      status: 'failed',
      worker_report: reportBody,
      changed_files_count: 500,
      changed_files_truncated: true,
      owned_paths_violations_count: 500,
      owned_paths_violations_truncated: true,
      output_tail_truncated: true
    })
    expect(artifact.changed_files).toEqual(paths.slice(0, artifact.changed_files.length))
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
  })

  it('records and releases a failed attempt when the exact report cannot fit the artifact bound', async () => {
    const reportBody = '界'.repeat(32_000)
    const { record, ctx } = await prepared({ reportBody })
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    const result = f.journal.read(record.worker.dispatch_id)!
    expect(result).toMatchObject({
      status: 'failed',
      worker_report: reportBody,
      output_tail: expect.stringContaining('bounded evidence limit'),
      terminal_proof: { kind: 'exited', process_exit_code: 0 }
    })
    expect(result).not.toHaveProperty('file_id')
    expect(result).not.toHaveProperty('artifact_sha256')
    expect(f.port.publishFolderArtifact).not.toHaveBeenCalled()
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.journal.record).toHaveBeenCalledOnce()
  })

  it.each([
    { reason: 'worker failure', succeeded: false, exitCode: 0 },
    { reason: 'nonzero physical exit', succeeded: true, exitCode: 17 }
  ])('records failure for $reason even with an explicit artifact contract', async (options) => {
    const { record, ctx } = await prepared(options)
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.journal.read(record.worker.dispatch_id)).toMatchObject({
      status: 'failed',
      result_exit_code: options.exitCode
    })
    expect(reviews.publishConsoleJobReview).not.toHaveBeenCalled()
  })
  it.each(['dirty', 'outside scope', 'credential'] as const)(
    'refuses an unverifiable or unsafe %s candidate',
    async (kind) => {
      const { record, ctx, git } = await prepared()
      const path = kind === 'outside scope' ? 'outside.md' : 'README.md'
      await writeFile(
        join(record.attempt.worktreePath, path),
        kind === 'credential' ? 'opaque-bearer-sentinel' : 'changed\n'
      )
      if (kind !== 'dirty') {
        await git(['add', '.'])
        await git(['commit', '-m', 'candidate'])
      }
      await monitorConsoleJob(ctx, record, new AbortController().signal)
      const result = f.journal.read(record.worker.dispatch_id)!
      expect(result.status).toBe('failed')
      expect(result.output_tail).toContain(
        kind === 'dirty'
          ? 'Commit repository changes'
          : kind === 'credential'
            ? 'credential inspection'
            : 'Write scope violations'
      )
      expect(JSON.stringify(result)).not.toContain('opaque-bearer-sentinel')
      expect(reviews.publishConsoleJobReview).not.toHaveBeenCalled()
    }
  )
  it('requires the exact settled report and retains the worker when it is missing', async () => {
    const { record, ctx } = await prepared({ report: false })
    await expect(monitorConsoleJob(ctx, record, new AbortController().signal)).rejects.toThrow(
      'exact findings'
    )
    expect(f.port.publishFolderArtifact).not.toHaveBeenCalled()
    expect(f.journal.record).not.toHaveBeenCalled()
    expect(ctx.call).not.toHaveBeenCalled()
  })
  it('retains the worker when the artifact receipt is mismatched', async () => {
    const { record, ctx } = await prepared()
    vi.mocked(f.port.publishFolderArtifact!).mockResolvedValue({
      ok: true,
      data: { fileId: 'tfl_wrong', sha256: 'f'.repeat(64) }
    })
    await expect(monitorConsoleJob(ctx, record, new AbortController().signal)).rejects.toThrow(
      'exact uploaded report'
    )
    expect(f.journal.record).not.toHaveBeenCalled()
    expect(ctx.call).not.toHaveBeenCalled()
  })
  it('does not reinterpret a legacy empty Git acceptance contract as success', async () => {
    delete f.job.artifactResult
    const { record, ctx } = await prepared()
    vi.mocked(reviews.publishConsoleJobReview).mockImplementation(
      async (_job, _cwd, result) => result
    )
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.journal.read(record.worker.dispatch_id)).toMatchObject({
      status: 'failed',
      exit_code: null,
      output_tail: expect.stringContaining('did not provide an executable acceptance contract')
    })
    expect(f.port.publishFolderArtifact).not.toHaveBeenCalled()
  })
})
