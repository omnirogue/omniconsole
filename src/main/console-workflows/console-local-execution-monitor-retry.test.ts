import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { ConsoleResultJournal } from './console-job-monitor'
import type { ConsoleLocalExecutionPort } from './console-local-execution-contract'
import type { ConsoleLocalExecutionRecord } from './console-local-execution-state'

const monitor = vi.hoisted(() => vi.fn())
const cancel = vi.hoisted(() => vi.fn())
vi.mock('./console-job-monitor', () => ({ monitorConsoleJob: monitor }))
vi.mock('./console-local-cancellation', () => ({ cancelConsoleLocalExecution: cancel }))
vi.mock('./console-worker-start-gate', () => ({ registerConsoleWorkerStartPort: () => () => {} }))
vi.mock('./console-job-process-observation', () => ({
  consoleJobProcessIdentity: () => ({}),
  observeConsoleJobProcess: async () => ({ state: 'live' })
}))
vi.mock('./console-local-execution-state', () => ({
  listConsoleLocalExecutions: () => [record]
}))

const { ConsoleLocalExecution } = await import('./console-local-execution')

const record = {
  worker: { dispatch_id: 'dispatch-1' },
  binding: { jobId: 'job_one' },
  view: { jobId: 'job_one', state: 'running' }
} as unknown as ConsoleLocalExecutionRecord

const RETRY_MS = 60_000

describe('ConsoleLocalExecution monitor retry', () => {
  let service: InstanceType<typeof ConsoleLocalExecution>

  beforeEach(() => {
    vi.useFakeTimers()
    monitor.mockReset()
    cancel.mockReset()
    const port = {
      principal: async () => 'emp_sal',
      sanitize: (text: string) => text
    } as unknown as ConsoleLocalExecutionPort
    const results = { read: () => undefined } as unknown as ConsoleResultJournal
    service = new ConsoleLocalExecution(
      { getOrchestrationDb: () => ({}) } as unknown as OrcaRuntimeService,
      port,
      results,
      vi.fn()
    )
  })
  afterEach(() => {
    service.dispose()
    vi.useRealTimers()
  })

  const settle = () => vi.advanceTimersByTimeAsync(0)

  it('watches a Dispatch again once the cool-down after a failed monitor has passed', async () => {
    monitor.mockRejectedValueOnce(new Error('host busy')).mockReturnValue(new Promise(() => {}))
    await service.list()
    await settle()
    expect(monitor).toHaveBeenCalledTimes(1)
    const failed = await service.list()
    expect(failed).toMatchObject({
      ok: true,
      data: [{ state: 'unverifiable', error: 'host busy' }]
    })
    expect(monitor).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(RETRY_MS)
    const retried = await service.list()
    expect(monitor).toHaveBeenCalledTimes(2)
    // The first list of the retry still reports the old failure; the next one no longer does.
    expect(retried).toMatchObject({ ok: true, data: [{ error: 'host busy' }] })
    const after = await service.list()
    expect(after).toMatchObject({ ok: true, data: [{ state: 'running' }] })
    expect(after.ok && after.data[0]).not.toHaveProperty('error')
    expect(monitor).toHaveBeenCalledTimes(2)
  })

  it("keeps a cancel's error final, even after a monitor failure", async () => {
    monitor.mockRejectedValue(new Error('lost contact'))
    await service.list()
    await settle()
    cancel.mockResolvedValue({ ...record.view, error: 'stop unknown' })
    await service.cancel({ jobId: 'job_one' })

    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    const listed = await service.list()
    expect(monitor).toHaveBeenCalledTimes(1)
    expect(listed).toMatchObject({ ok: true, data: [{ error: 'stop unknown' }] })
  })
})
