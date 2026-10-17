import { afterEach, describe, expect, it, vi } from 'vitest'
import { readConsoleJobProcessHandshake } from '../runtime/orchestration/console-job-process-handshake'
import { createConsoleProcessObservationFixture } from './console-job-process-observation.test-fixture'
import { runConsoleJobAcceptance } from './console-job-acceptance'
import type * as AcceptanceModule from './console-job-acceptance'
import { publishConsoleJobReview } from './console-job-review'
import { consoleJobOutputDigest } from './console-job-digests'
import { monitorConsoleJob } from './console-job-monitor'
import type { ConsoleLocalResult } from './console-local-execution-contract'

vi.mock('./console-job-acceptance', async (original) => ({
  ...(await original<typeof AcceptanceModule>()),
  runConsoleJobAcceptance: vi.fn()
}))
vi.mock('./console-job-review', () => ({
  publishConsoleJobReview: vi.fn(async (_job, _cwd, result) => result)
}))

describe('console monitor physical completion order', () => {
  const fixtures: ReturnType<typeof createConsoleProcessObservationFixture>[] = []
  function fixture() {
    const f = createConsoleProcessObservationFixture()
    fixtures.push(f)
    f.settle()
    vi.mocked(runConsoleJobAcceptance).mockImplementation(async () => {
      expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeDefined()
      return {
        status: 'done',
        exit_code: 0,
        result_exit_code: 0,
        output_tail: 'Acceptance exit 0',
        candidate_sha: 'd'.repeat(40),
        branch: 'main',
        pr_url: null,
        pr_number: null,
        changed_files: [],
        owned_paths_violations: [],
        terminal_proof: { kind: 'acceptance_process', exit_code: 0 },
        output_digest: ''
      } satisfies ConsoleLocalResult
    })
    return f
  }
  afterEach(() => {
    for (const f of fixtures.splice(0)) {
      f.db.close()
    }
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('requests natural exit before acceptance, retains physical 37, then releases through real RPC', async () => {
    const f = fixture()
    vi.mocked(publishConsoleJobReview).mockImplementationOnce(async (_job, _cwd, result) => {
      expect(result.terminal_proof).toMatchObject({ kind: 'exited', process_exit_code: 37 })
      expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeDefined()
      return result
    })
    await monitorConsoleJob(f.ctx, f.record(), new AbortController().signal)
    expect(f.runtime.sendTerminal).toHaveBeenCalledTimes(1)
    expect(runConsoleJobAcceptance).toHaveBeenCalledTimes(1)
    const result = f.ctx.results.read(f.identity.dispatchId)!
    expect(result).toMatchObject({
      status: 'done',
      result_exit_code: 0,
      terminal_proof: { process_exit_code: 37, exit_cause: { kind: 'exited', exit_code: 37 } }
    })
    expect(result.output_digest).toBe(consoleJobOutputDigest(result))
    expect(f.db.getWorkerTerminalResourceByOwner(f.identity.dispatchId)?.release_state).toBe(
      'released'
    )
    expect(f.runtime.closeTerminal).toHaveBeenCalledExactlyOnceWith('term_process')
  })

  it('does not run acceptance, review, publish or cleanup for an unobserved physical exit', async () => {
    const f = fixture()
    f.state.observation = { ...f.fields, state: 'unverifiable', reason: 'host disconnected' }
    await expect(
      monitorConsoleJob(f.ctx, f.record(), new AbortController().signal)
    ).rejects.toThrow('unverifiable')
    expect(runConsoleJobAcceptance).not.toHaveBeenCalled()
    expect(publishConsoleJobReview).not.toHaveBeenCalled()
    expect(f.ctx.results.record).not.toHaveBeenCalled()
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retains physical proof when independent acceptance fails', async () => {
    const f = fixture()
    const acceptance = vi.mocked(runConsoleJobAcceptance).getMockImplementation()!
    vi.mocked(runConsoleJobAcceptance).mockImplementationOnce(async (args) => ({
      ...(await acceptance(args)),
      status: 'failed',
      exit_code: 5,
      result_exit_code: 5
    }))
    await monitorConsoleJob(f.ctx, f.record(), new AbortController().signal)
    expect(f.ctx.results.read(f.identity.dispatchId)).toMatchObject({
      status: 'failed',
      result_exit_code: 5,
      terminal_proof: { process_exit_code: 37 }
    })
  })

  it('physical proof stays committed when review publication fails', async () => {
    const f = fixture()
    vi.mocked(publishConsoleJobReview).mockRejectedValueOnce(new Error('review unavailable'))
    await monitorConsoleJob(f.ctx, f.record(), new AbortController().signal)
    expect(f.ctx.results.read(f.identity.dispatchId)).toMatchObject({
      status: 'failed',
      terminal_proof: { process_exit_code: 37 },
      output_tail: expect.stringContaining('review unavailable')
    })
  })

  it('does not close a reused pane even when the old process has durable physical proof', async () => {
    const f = fixture()
    f.exit(0)
    const acceptance = vi.mocked(runConsoleJobAcceptance).getMockImplementation()!
    vi.mocked(runConsoleJobAcceptance).mockImplementationOnce(async (args) => {
      const result = await acceptance(args)
      vi.mocked(f.runtime.getTerminalProcessIncarnation).mockReturnValue('another:incarnation')
      return result
    })
    await monitorConsoleJob(f.ctx, f.record(), new AbortController().signal)
    expect(f.ctx.results.read(f.identity.dispatchId)?.status).toBe('done')
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(f.db.getWorkerTerminalResourceByOwner(f.identity.dispatchId)?.release_state).toBe(
      'retained'
    )
  })

  it('an abort during natural exit persists death without acceptance or publication', async () => {
    const f = fixture()
    const controller = new AbortController()
    const wait = vi.mocked(f.runtime.waitForTerminal).getMockImplementation()!
    vi.mocked(f.runtime.waitForTerminal).mockImplementation(async (handle, options) => {
      const result = await wait(handle, options)
      if (options?.condition === 'exit') {
        controller.abort()
      }
      return result
    })
    await monitorConsoleJob(f.ctx, f.record(), controller.signal)
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeDefined()
    expect(runConsoleJobAcceptance).not.toHaveBeenCalled()
    expect(f.ctx.results.record).not.toHaveBeenCalled()
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('carries the exact committed review findings independently of acceptance output', async () => {
    const f = fixture()
    const record = f.record()
    record.attempt.job.action = 'review'
    const report = '{"verdict":"APPROVE","findings":["Verified the process identity fence"]}'
    f.db.insertMessage({
      runId: record.run.id,
      from: record.worker.agent_terminal_handle!,
      to: `run:${record.run.id}`,
      type: 'worker_done',
      subject: 'Review complete',
      body: report,
      payload: JSON.stringify({
        taskId: f.db.getDispatchContextById(f.identity.dispatchId)!.task_id,
        dispatchId: f.identity.dispatchId,
        outcome: 'succeeded'
      })
    })
    await monitorConsoleJob(f.ctx, record, new AbortController().signal)
    expect(f.ctx.results.read(f.identity.dispatchId)).toMatchObject({
      worker_report: report,
      review_text: report,
      output_tail: 'Acceptance exit 0',
      terminal_proof: { process_exit_code: 37 }
    })
  })

  it('refuses review publication when the exact settled findings are missing', async () => {
    const f = fixture()
    const record = f.record()
    record.attempt.job.action = 'review'
    await expect(monitorConsoleJob(f.ctx, record, new AbortController().signal)).rejects.toThrow(
      'exact findings'
    )
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeDefined()
    expect(runConsoleJobAcceptance).not.toHaveBeenCalled()
    expect(f.ctx.results.record).not.toHaveBeenCalled()
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
  })
})
