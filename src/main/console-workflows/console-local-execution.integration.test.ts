import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from '../git/runner'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import { createOrchestrationCaller } from '../runtime/build-review/build-review-rpc-call'
import { ConsoleLocalExecution } from './console-local-execution'
import type { ConsoleLocalJob, ConsoleLocalExecutionPort } from './console-local-execution-contract'
import type { ConsoleResultJournal } from './console-job-monitor'
import { createConsoleLocalExecutionFixture } from './console-local-execution-test-fixture'
import { ConsoleAutoAdvance } from './console-auto-advance'
import { autoAdvanceJob } from './console-auto-advance-test-fixture'
import { consoleAutoAdvanceOff } from '../../shared/console-auto-advance'
import { PtyLaunchGateRegistry } from '../providers/pty-launch-gate-registry'

describe('explicit console activation through real Orca Run and Dispatch records', () => {
  let directory: string
  let cwd: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let service: ConsoleLocalExecution
  let job: ConsoleLocalJob
  let port: ConsoleLocalExecutionPort
  let journal: ConsoleResultJournal
  let exitGate: (exitCode: number | null, signal?: number | null) => void
  const request = () => ({
    jobId: job.id,
    workflowId: job.workflowId,
    approvedDigest: job.digest,
    worktree: 'id:source'
  })
  const git = (args: string[], path = cwd) => gitExecFileAsync(args, { cwd: path })

  beforeEach(async () => {
    ;({ directory, cwd, db, runtime, service, job, port, journal, exitGate } =
      await createConsoleLocalExecutionFixture())
  })
  afterEach(async () => {
    service.dispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    db.close()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  it('does not activate on construction, list, absent approval, a changed digest or fleet placement', async () => {
    expect(await service.list()).toEqual({ ok: true, data: [] })
    expect((await service.start({ ...request(), approvedDigest: '' })).ok).toBe(false)
    expect((await service.start({ ...request(), approvedDigest: 'c'.repeat(64) })).ok).toBe(false)
    job.placement = 'fleet'
    expect((await service.start(request())).ok).toBe(false)
    expect(port.activate).not.toHaveBeenCalled()
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('activates one named job with immutable card projection and persisted process admission', async () => {
    const started = await service.start(request())
    expect(started.ok).toBe(true)
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    expect(port.activate).toHaveBeenCalledExactlyOnceWith(request())
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: job.baseSha, branchNameOverride: `omni/${job.id}` })
    )
    const worker = db.getWorkerDispatch(started.data.dispatchId!)!
    const run = db.getRun(started.data.runId)!
    expect(JSON.parse(run.console_job!)).toMatchObject({
      claim: consoleJobClaimFixture.claim,
      leaseGeneration: 3
    })
    expect(run.console_job_dispatch_id).toBe(started.data.dispatchId)
    expect(JSON.parse(run.console_job!).sessionId).toBeUndefined()
    expect(JSON.parse(run.console_job_start_receipt!).sessionId).toBe('ses_server')
    expect(db.listTasks({ runId: run.id })).toHaveLength(1)
    expect(db.listTasks({ runId: run.id })[0].hub_task_id).toBe(job.taskId)
    expect(JSON.parse(worker.start_options).consoleExecution.attemptStartSha).toBe(job.baseSha)
    const prompt = vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0][1]
    for (const text of [
      'Exact stored prompt',
      'Exact stored brief',
      'explicit-input',
      'Owned paths:',
      'README.md'
    ]) {
      expect(prompt).toContain(text)
    }
    expect(JSON.stringify(worker)).not.toMatch(
      /machineToken|seatMap|slots|runner\/beat|runner\/next/
    )
  })

  it.each(['missing', 'unreachable'] as const)(
    'reports the first restored list as unverifiable when the native observer is %s',
    async (observation) => {
      const started = await service.start(request())
      expect(started).toMatchObject({ ok: true, data: { state: 'running' } })
      if (!started.ok) {
        throw new Error(started.error.message)
      }
      service.dispose()
      expect(db.getWorkerDispatch(started.data.dispatchId!)!.state).toBe('ready')
      const read = vi.mocked(runtime.readTerminalLaunchGateObservation)
      if (observation === 'missing') {
        read.mockImplementation(new PtyLaunchGateRegistry().readObservation)
      } else {
        read.mockRejectedValue(new Error('Native process owner unavailable'))
      }
      vi.mocked(runtime.createTerminal).mockClear()
      vi.mocked(port.activate).mockClear()
      vi.mocked(port.startProcess!).mockClear()
      service = new ConsoleLocalExecution(runtime, port, journal)

      expect(await service.list()).toMatchObject({
        ok: true,
        data: [
          {
            dispatchId: started.data.dispatchId,
            state: 'unverifiable',
            error: 'The host did not verify the exact process identity.'
          }
        ]
      })
      expect(runtime.createTerminal).not.toHaveBeenCalled()
      expect(port.activate).not.toHaveBeenCalled()
      expect(port.startProcess).not.toHaveBeenCalled()
      expect(journal.record).not.toHaveBeenCalled()
      expect(port.result).not.toHaveBeenCalled()
    }
  )

  it('reports a restored worker as running only after its exact native observer confirms it live', async () => {
    const started = await service.start(request())
    expect(started).toMatchObject({ ok: true, data: { state: 'running' } })
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    service.dispose()
    vi.mocked(runtime.readTerminalLaunchGateObservation).mockClear()
    vi.mocked(runtime.createTerminal).mockClear()
    service = new ConsoleLocalExecution(runtime, port, journal)

    expect(await service.list()).toMatchObject({
      ok: true,
      data: [{ dispatchId: started.data.dispatchId, state: 'running' }]
    })
    expect(runtime.readTerminalLaunchGateObservation).toHaveBeenCalledOnce()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('leaves the gate closed and the prompt unsent when canonical process start is refused', async () => {
    vi.mocked(port.startProcess!).mockResolvedValue({
      ok: false,
      error: { code: 'stale_claim', message: 'claim changed while starting' }
    })
    const result = await service.start(request())
    expect(result).toMatchObject({
      ok: true,
      data: { state: 'unverifiable', error: 'claim changed while starting' }
    })
    expect(runtime.releaseTerminalLaunchGate).not.toHaveBeenCalled()
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    if (result.ok) {
      expect(db.getRun(result.data.runId)!.console_job_start_receipt).toBeNull()
      expect(db.getWorkerTerminalResourceByOwner(result.data.dispatchId!)?.ownership_state).toBe(
        'owned'
      )
    }
  })

  it('refuses protected prompt material before launching a worktree or subprocess', async () => {
    job.prompt = 'opaque-bearer-sentinel'
    const result = await service.start(request())
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(job.prompt)
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(JSON.stringify(db.listRuns())).not.toContain(job.prompt)
    expect((await git(['config', '--local', '--list'])).stdout).not.toContain(job.prompt)
  })

  it('rejects a worker request that drops or changes its bound execution context', async () => {
    const started = await service.start(request())
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    const worker = db.getWorkerDispatch(started.data.dispatchId!)!
    const input = JSON.parse(worker.start_options).consoleExecution
    const call = createOrchestrationCaller(runtime)
    const params = {
      task: db.listTasks({ runId: started.data.runId })[0].id,
      from: db.getRun(started.data.runId)!.coordinator_handle,
      worktree: `id:${input.worktreeId}`,
      agent: job.provider,
      model: job.model,
      effort: job.effort,
      executionBrief: 'Bound instructions'
    }
    vi.mocked(runtime.createTerminal).mockClear()
    await expect(call('orchestration.workerStart', params)).rejects.toThrow(
      'preserve its admitted job'
    )
    await expect(
      call('orchestration.workerStart', {
        ...params,
        consoleExecution: input,
        model: 'another-model'
      })
    ).rejects.toThrow('preserve its admitted job')
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('stops only the bound Dispatch and reports cancelled after confirmed stop', async () => {
    const started = await service.start(request())
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    service.dispose()
    const call = vi.fn(async () => {
      exitGate(null, 9)
      return { state: 'stopped' }
    })
    service = new ConsoleLocalExecution(runtime, port, journal, call as never)
    const cancelled = await service.cancel({ jobId: job.id })
    expect(cancelled).toMatchObject({ ok: true, data: { state: 'cancelled' } })
    expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.workerStop', {
      dispatch: started.data.dispatchId
    })
    expect(journal.record).toHaveBeenCalledWith(
      expect.objectContaining({ binding: expect.objectContaining({ leaseGeneration: 3 }) }),
      expect.objectContaining({
        status: 'cancelled',
        terminal_proof: expect.objectContaining({
          kind: 'exited',
          process_exit_code: null,
          exit_cause: { kind: 'signaled', signal: 9 }
        })
      })
    )
  })

  it('keeps contact loss unverifiable and never publishes a cancellation from an unknown stop', async () => {
    const started = await service.start(request())
    if (!started.ok) {
      throw new Error(started.error.message)
    }
    service.dispose()
    service = new ConsoleLocalExecution(
      runtime,
      port,
      journal,
      vi.fn().mockResolvedValue({ state: 'stop_unknown' })
    )
    expect(await service.cancel({ jobId: job.id })).toMatchObject({
      ok: true,
      data: { state: 'unverifiable' }
    })
    expect(journal.record).not.toHaveBeenCalled()
    const call = createOrchestrationCaller(runtime)
    await expect(
      call('orchestration.workerStart', {
        task: db.listTasks({ runId: started.data.runId })[0].id,
        from: db.getRun(started.data.runId)!.coordinator_handle,
        on: 'missing-host',
        agent: 'codex',
        executionBrief: 'Bound instructions',
        consoleExecution: JSON.parse(db.getWorkerDispatch(started.data.dispatchId!)!.start_options)
          .consoleExecution
      })
    ).rejects.toThrow()
  })

  it('auto-advance activates through the same named start the person clicks', async () => {
    const preference = {
      workflowId: job.workflowId,
      enabled: true,
      worktree: 'id:source',
      status: consoleAutoAdvanceOff(job.workflowId, 'id:source').status
    }
    const advance = new ConsoleAutoAdvance({
      readWorkflow: async () => ({
        ok: true,
        data: {
          workflow_id: job.workflowId,
          jobs: [autoAdvanceJob({ id: job.id, workflowId: job.workflowId })]
        }
      }),
      // The exact function the Jobs view calls; auto-advance owns no copy of it.
      start: (input) => service.start(input),
      preference: () => preference,
      record: () => {},
      sanitize: (text) => text
    })
    const status = await advance.cycle(job.workflowId)
    expect(status).toMatchObject({ state: 'activated', jobId: job.id })
    expect(port.getReadyJob).toHaveBeenCalledWith(request())
    expect(port.activate).toHaveBeenCalledExactlyOnceWith(request())
    const listed = await service.list()
    if (!listed.ok) {
      throw new Error(listed.error.message)
    }
    expect(listed.data[0]).toMatchObject({ jobId: job.id, workflowId: job.workflowId })
  })
})
