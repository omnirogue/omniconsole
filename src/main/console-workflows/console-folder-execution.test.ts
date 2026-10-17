import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitRunner from '../git/runner'
import { readConsoleJobProcessHandshake } from '../runtime/orchestration/console-job-process-handshake'
import * as acceptance from './console-job-acceptance'
import * as reviews from './console-job-review'
import { consoleJobOutputDigest } from './console-job-digests'
import { ConsoleJobResultGate } from './console-job-result-gate'
import { monitorConsoleJob } from './console-job-monitor'
import { listConsoleLocalExecutions } from './console-local-execution-state'
import { createConsoleLocalExecutionFixture } from './console-local-execution-test-fixture'

describe('signed console job execution in an existing native folder', () => {
  let f: Awaited<ReturnType<typeof createConsoleLocalExecutionFixture>>
  const request = () => ({
    jobId: f.job.id,
    workflowId: f.job.workflowId,
    approvedDigest: f.job.digest,
    worktree: 'id:folder:local-fixture'
  })

  beforeEach(async () => {
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockRejectedValue(
      new Error('Folder execution must not invoke Git.')
    )
    vi.spyOn(acceptance, 'runConsoleJobAcceptance').mockRejectedValue(
      new Error('Folder execution must not invoke Git acceptance.')
    )
    vi.spyOn(reviews, 'publishConsoleJobReview').mockRejectedValue(
      new Error('Folder execution must not publish a hosted review.')
    )
    f = await createConsoleLocalExecutionFixture({ workspaceKind: 'folder' })
  })

  afterEach(async () => {
    f.service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    f.db.close()
    vi.restoreAllMocks()
    await rm(f.directory, { recursive: true, force: true })
  })

  function expectNoGit() {
    expect(gitRunner.gitExecFileAsync).not.toHaveBeenCalled()
    expect(f.runtime.showRepo).not.toHaveBeenCalled()
    expect(f.runtime.listManagedWorktrees).not.toHaveBeenCalled()
    expect(f.runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(acceptance.runConsoleJobAcceptance).not.toHaveBeenCalled()
    expect(reviews.publishConsoleJobReview).not.toHaveBeenCalled()
  }

  async function start() {
    const started = await f.service.start(request())
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    return started.data
  }

  async function settled(outcome: 'succeeded' | 'failed' = 'succeeded', withReport = true) {
    const view = await start()
    f.service.dispose()
    vi.mocked(f.port.inspect).mockResolvedValue({ ok: true, data: { cancelled: false } })
    const record = listConsoleLocalExecutions(f.db, (await f.port.principal())!)[0]
    const task = f.db.getDispatchContextById(view.dispatchId!)!
    f.db.settleWorkerReport({
      taskId: task.task_id,
      dispatchId: view.dispatchId!,
      outcome,
      result: 'Folder artifact prepared'
    })
    if (withReport) {
      f.db.insertMessage({
        runId: record.run.id,
        from: record.worker.agent_terminal_handle!,
        to: `run:${record.run.id}`,
        type: 'worker_done',
        subject: 'Folder work complete',
        body: 'Created the requested folder artifact and checked its contents.',
        payload: JSON.stringify({
          taskId: task.task_id,
          dispatchId: view.dispatchId,
          outcome
        })
      })
    }
    const ctx = {
      runtime: f.runtime,
      port: f.port,
      results: f.journal,
      resultGate: new ConsoleJobResultGate(),
      call: vi.fn().mockResolvedValue({}),
      cancel: vi.fn()
    }
    return { ctx, record, view }
  }

  it('reuses the folder and preserves the signed claim, closed gate and hub start receipt', async () => {
    const originalStart = vi.mocked(f.port.startProcess!).getMockImplementation()!
    vi.mocked(f.port.startProcess!).mockImplementation(async (input) => {
      expect(input).toMatchObject({
        projectDir: f.cwd,
        baseSha: null,
        gate: { state: 'closed', startupCommandMode: 'exec' },
        job: { workspace: { kind: 'folder', path: f.cwd } }
      })
      expect(f.runtime.releaseTerminalLaunchGate).not.toHaveBeenCalled()
      expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
      return originalStart(input)
    })
    const view = await start()
    expect(view).toMatchObject({ worktreeId: 'folder:local-fixture', branch: null })
    expect(f.port.activate).toHaveBeenCalledExactlyOnceWith(request())
    expect(f.port.startProcess).toHaveBeenCalledOnce()
    expect(f.runtime.releaseTerminalLaunchGate).toHaveBeenCalledOnce()
    expect(f.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce()
    const run = f.db.getRun(view.runId)!
    expect(JSON.parse(run.console_job_start_receipt!)).toMatchObject({
      sessionId: 'ses_server',
      attemptId: 'attempt_server'
    })
    const worker = f.db.getWorkerDispatch(view.dispatchId!)!
    expect(JSON.parse(worker.start_options).consoleExecution).toMatchObject({
      worktreeId: 'folder:local-fixture',
      worktreePath: f.cwd,
      attemptStartSha: null,
      branch: null,
      job: { repo: null, baseBranch: null, baseSha: null }
    })
    expect(f.db.listTasks({ runId: run.id })[0].hub_task_id).toBe(f.job.taskId)
    expect(await readFile(join(f.cwd, 'README.md'), 'utf8')).toBe('fixture\n')
    expectNoGit()
  })

  it('keeps the gate closed and prompt unsent when the hub refuses process start', async () => {
    vi.mocked(f.port.startProcess!).mockResolvedValue({
      ok: false,
      error: { code: 'stale_claim', message: 'Folder claim changed while starting.' }
    })
    const view = await start()
    expect(view).toMatchObject({
      state: 'unverifiable',
      error: 'Folder claim changed while starting.'
    })
    expect(f.db.getRun(view.runId)!.console_job_start_receipt).toBeNull()
    expect(f.runtime.releaseTerminalLaunchGate).not.toHaveBeenCalled()
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expectNoGit()
  })

  it('awaits prepared inputs before launch and preserves their paths separately from frozen inputs', async () => {
    const inputs = structuredClone(f.job.inputs)
    const paths = [join(f.cwd, 'brief.txt')]
    const entered = Promise.withResolvers<void>()
    const prepared = Promise.withResolvers<string[]>()
    f.port.prepareInputs = vi.fn(() => {
      entered.resolve()
      return prepared.promise
    })
    const pending = start()
    await entered.promise
    expect(f.port.prepareInputs).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inputs, workspace: { kind: 'folder', path: f.cwd } }),
      f.cwd
    )
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    prepared.resolve(paths)
    const view = await pending
    const worker = f.db.getWorkerDispatch(view.dispatchId!)!
    expect(JSON.parse(worker.start_options).consoleExecution).toMatchObject({
      preparedInputPaths: paths,
      job: { inputs }
    })
    expect(vi.mocked(f.runtime.sendTerminalAgentPrompt).mock.calls[0][1]).toContain(paths[0])
    expect(f.job.inputs).toEqual(inputs)
    expectNoGit()
  })

  it('refuses launch when input preparation fails', async () => {
    f.port.prepareInputs = vi.fn().mockRejectedValue(new Error('Attachment download failed.'))
    expect(await f.service.start(request())).toMatchObject({
      ok: false,
      error: { message: 'Attachment download failed.' }
    })
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.port.startProcess).not.toHaveBeenCalled()
    expect(f.runtime.releaseTerminalLaunchGate).not.toHaveBeenCalled()
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expectNoGit()
  })

  it('rejects a different selected folder before activation or terminal creation', async () => {
    const other = join(f.directory, 'other')
    await mkdir(other)
    vi.mocked(f.runtime.showManagedTerminalWorkspace).mockResolvedValue({
      id: 'folder:other',
      repoId: 'folder-workspace:other',
      hostId: 'local',
      git: { path: other, branch: '' }
    } as never)
    expect((await f.service.start(request())).ok).toBe(false)
    expect(f.port.activate).not.toHaveBeenCalled()
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expectNoGit()
  })

  it.each(['remote', 'git'])(
    'rejects a %s workspace posing as the admitted folder',
    async (kind) => {
      vi.mocked(f.runtime.showManagedTerminalWorkspace).mockResolvedValue({
        id: kind === 'git' ? 'worktree:git-fixture' : 'folder:local-fixture',
        repoId: kind === 'git' ? 'git-fixture' : 'folder-workspace:local-fixture',
        hostId: kind === 'remote' ? 'remote-host' : 'local',
        git: { path: f.cwd, branch: kind === 'git' ? 'main' : '' }
      } as never)
      expect((await f.service.start(request())).ok).toBe(false)
      expect(f.port.activate).not.toHaveBeenCalled()
      expect(f.runtime.createTerminal).not.toHaveBeenCalled()
      expectNoGit()
    }
  )

  it('refuses a folder without its explicit folder contract', async () => {
    delete f.job.workspace
    f.job.repo = 'gitlab.example/team/project'
    f.job.baseBranch = 'main'
    f.job.baseSha = 'a'.repeat(40)
    expect((await f.service.start(request())).ok).toBe(false)
    expect(f.port.activate).not.toHaveBeenCalled()
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(gitRunner.gitExecFileAsync).not.toHaveBeenCalled()
  })

  it.each([
    { outcome: 'succeeded' as const, exitCode: 0, status: 'done' },
    { outcome: 'succeeded' as const, exitCode: 37, status: 'failed' },
    { outcome: 'failed' as const, exitCode: 0, status: 'failed' }
  ])('publishes $status from worker $outcome with physical exit $exitCode', async (input) => {
    const { ctx, record } = await settled(input.outcome)
    f.exitGate(input.exitCode)
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    const result = f.journal.read(record.worker.dispatch_id)!
    expect(result).toMatchObject({
      status: input.status,
      exit_code: input.exitCode,
      result_exit_code: input.exitCode,
      file_id: 'tfl_folderartifact',
      candidate_sha: null,
      branch: null,
      pr_url: null,
      pr_number: null,
      changed_files: [],
      owned_paths_violations: [],
      worker_report: 'Created the requested folder artifact and checked its contents.',
      terminal_proof: {
        kind: 'exited',
        process_exit_code: input.exitCode,
        exit_cause: { kind: 'exited', exit_code: input.exitCode }
      }
    })
    expect(f.port.publishFolderArtifact).toHaveBeenCalledOnce()
    const upload = vi.mocked(f.port.publishFolderArtifact!).mock.calls[0][0]
    expect(upload).toMatchObject({
      binding: record.binding,
      principal: record.run.console_job_principal,
      job: record.attempt.job
    })
    const content = Buffer.from(upload.contentBase64, 'base64')
    expect(JSON.parse(content.toString('utf8'))).toMatchObject({
      status: input.status,
      exit_code: input.exitCode,
      result_exit_code: input.exitCode,
      worker_report: result.worker_report,
      terminal_proof: result.terminal_proof
    })
    expect(result.artifact_sha256).toBe(createHash('sha256').update(content).digest('hex'))
    expect(vi.mocked(f.port.publishFolderArtifact!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.journal.record).mock.invocationCallOrder[0]
    )
    expect(result.output_digest).toBe(consoleJobOutputDigest(result))
    expect(consoleJobOutputDigest({ ...result, artifact_sha256: 'a'.repeat(64) })).not.toBe(
      result.output_digest
    )
    expect(f.journal.flush).toHaveBeenCalledOnce()
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
    expectNoGit()
  })

  it('waits for the verified artifact upload before recording completion or releasing the worker', async () => {
    const { ctx, record } = await settled()
    f.exitGate(0)
    const entered = Promise.withResolvers<string>()
    const receipt = Promise.withResolvers<{ ok: true; data: { fileId: string; sha256: string } }>()
    f.port.publishFolderArtifact = vi.fn((input) => {
      entered.resolve(input.contentBase64)
      return receipt.promise
    })
    const pending = monitorConsoleJob(ctx, record, new AbortController().signal)
    const content = Buffer.from(await entered.promise, 'base64')
    expect(f.journal.record).not.toHaveBeenCalled()
    expect(ctx.call).not.toHaveBeenCalled()
    receipt.resolve({
      ok: true,
      data: { fileId: 'tfl_verified', sha256: createHash('sha256').update(content).digest('hex') }
    })
    await pending
    expect(f.journal.read(record.worker.dispatch_id)).toMatchObject({ file_id: 'tfl_verified' })
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
    expectNoGit()
  })

  it('records and releases a failed attempt when a selected file cannot fit the snapshot artifact', async () => {
    const original = Buffer.from('original\n')
    const sha256 = createHash('sha256').update(original).digest('hex')
    f.job.artifactResult = { path: 'folder-snapshot.json', format: 'json', maxBytes: 65536 }
    f.job.ownedPaths = ['selected.txt']
    f.job.inputs = [
      {
        loop_stage: { key: 'producer', role: 'producer', round: 1 },
        current_source: { snapshot_digest: sha256 },
        source_files: [{ kind: 'task_file', target_path: 'selected.txt', file: { sha256 } }]
      }
    ]
    // 50 000 raw bytes fit the per-file bound; their base64 in the report does not.
    await writeFile(join(f.cwd, 'selected.txt'), Buffer.alloc(50_000, 1))
    const { ctx, record } = await settled()
    f.exitGate(0)
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    const result = f.journal.read(record.worker.dispatch_id)!
    expect(result).toMatchObject({
      status: 'failed',
      output_tail: expect.stringContaining('bounded evidence limit'),
      terminal_proof: { kind: 'exited', process_exit_code: 0 }
    })
    expect(result).not.toHaveProperty('file_id')
    expect(f.port.publishFolderArtifact).not.toHaveBeenCalled()
    expect(ctx.call).toHaveBeenCalledExactlyOnceWith('orchestration.workerRelease', {
      dispatch: record.worker.dispatch_id
    })
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.journal.record).toHaveBeenCalledOnce()
    expectNoGit()
  })

  it.each(['missing adapter', 'refused upload', 'rejected upload', 'mismatched hash'])(
    'retains the settled worker without recording a result after %s',
    async (failure) => {
      const { ctx, record } = await settled()
      f.exitGate(0)
      if (failure === 'missing adapter') {
        delete f.port.publishFolderArtifact
      } else if (failure === 'refused upload') {
        vi.mocked(f.port.publishFolderArtifact!).mockResolvedValue({
          ok: false,
          error: { code: 'artifact_refused', message: 'Artifact upload refused.' }
        })
      } else if (failure === 'rejected upload') {
        vi.mocked(f.port.publishFolderArtifact!).mockRejectedValue(
          new Error('Upload disconnected.')
        )
      } else {
        vi.mocked(f.port.publishFolderArtifact!).mockResolvedValue({
          ok: true,
          data: { fileId: 'tfl_wrongcontent', sha256: 'f'.repeat(64) }
        })
      }
      await expect(monitorConsoleJob(ctx, record, new AbortController().signal)).rejects.toThrow()
      expect(f.journal.record).not.toHaveBeenCalled()
      expect(f.journal.flush).not.toHaveBeenCalled()
      expect(ctx.call).not.toHaveBeenCalled()
      expectNoGit()
    }
  )

  it('retries an already committed result without another artifact upload', async () => {
    const { ctx, record } = await settled()
    f.exitGate(0)
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    const frozen = f.journal.read(record.worker.dispatch_id)
    vi.mocked(f.runtime.readTerminalLaunchGateObservation).mockClear()
    await monitorConsoleJob(ctx, record, new AbortController().signal)
    expect(f.port.publishFolderArtifact).toHaveBeenCalledOnce()
    expect(f.journal.record).toHaveBeenCalledOnce()
    expect(f.journal.flush).toHaveBeenCalledTimes(2)
    expect(f.journal.read(record.worker.dispatch_id)).toEqual(frozen)
    expect(f.runtime.readTerminalLaunchGateObservation).not.toHaveBeenCalled()
    expect(ctx.call).toHaveBeenCalledOnce()
    expectNoGit()
  })

  it('retains the worker when the signed-in person changes during artifact upload', async () => {
    const { ctx, record } = await settled()
    f.exitGate(0)
    const upload = vi.mocked(f.port.publishFolderArtifact!).getMockImplementation()!
    const principal = vi.spyOn(f.port, 'principal')
    vi.mocked(f.port.publishFolderArtifact!).mockImplementation(async (input) => {
      const receipt = await upload(input)
      principal.mockResolvedValue('c'.repeat(64))
      return receipt
    })
    await expect(monitorConsoleJob(ctx, record, new AbortController().signal)).rejects.toThrow(
      'person changed'
    )
    expect(f.port.publishFolderArtifact).toHaveBeenCalledOnce()
    expect(f.journal.record).not.toHaveBeenCalled()
    expect(ctx.call).not.toHaveBeenCalled()
    expectNoGit()
  })

  it('keeps completion unverifiable without physical exit evidence', async () => {
    const { ctx, record } = await settled()
    const observe = vi.mocked(f.runtime.readTerminalLaunchGateObservation).getMockImplementation()!
    vi.mocked(f.runtime.readTerminalLaunchGateObservation).mockImplementation(async (gate) => ({
      ...(await observe(gate)),
      state: 'unverifiable',
      reason: 'Execution host disconnected.'
    }))
    await expect(monitorConsoleJob(ctx, record, new AbortController().signal)).rejects.toThrow(
      'unverifiable'
    )
    expect(f.journal.record).not.toHaveBeenCalled()
    expect(ctx.call).not.toHaveBeenCalled()
    expectNoGit()
  })

  it('refuses a physical exit without the exact committed worker report', async () => {
    const { ctx, record } = await settled('succeeded', false)
    f.exitGate(0)
    await expect(monitorConsoleJob(ctx, record, new AbortController().signal)).rejects.toThrow(
      'exact findings report'
    )
    expect(f.journal.record).not.toHaveBeenCalled()
    expect(ctx.call).not.toHaveBeenCalled()
    expectNoGit()
  })

  it('revalidates the folder identity after physical exit before recording the result', async () => {
    const { ctx, record } = await settled()
    f.exitGate(0)
    vi.mocked(f.runtime.showManagedTerminalWorkspace).mockResolvedValue({
      id: 'worktree:replacement',
      repoId: 'replacement',
      hostId: 'local',
      git: { path: f.cwd, branch: 'main' }
    } as never)
    await expect(monitorConsoleJob(ctx, record, new AbortController().signal)).rejects.toThrow()
    const identity = {
      runId: record.run.id,
      dispatchId: record.worker.dispatch_id,
      principal: record.run.console_job_principal!,
      binding: record.binding
    }
    expect(readConsoleJobProcessHandshake(f.db, identity)?.physicalExit).toBeDefined()
    expect(f.journal.record).not.toHaveBeenCalled()
    expect(ctx.call).not.toHaveBeenCalled()
    expectNoGit()
  })
})
