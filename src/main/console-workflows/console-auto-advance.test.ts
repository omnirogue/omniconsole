import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONSOLE_AUTO_ADVANCE_POLL_MS,
  CONSOLE_AUTO_ADVANCE_WINDOW_MS,
  consoleAutoAdvanceOff,
  type ConsoleAutoAdvancePreference,
  type ConsoleAutoAdvanceStatus
} from '../../shared/console-auto-advance'
import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import { ConsoleAutoAdvance, type ConsoleAutoAdvancePorts } from './console-auto-advance'
import {
  autoAdvanceJob,
  autoAdvanceWorkflowId as workflowId
} from './console-auto-advance-test-fixture'

const worktree = 'id:wt-console-1'

function createHarness(jobs: ConsoleWorkflowJob[]) {
  let preference: ConsoleAutoAdvancePreference = {
    workflowId,
    enabled: true,
    worktree,
    status: consoleAutoAdvanceOff(workflowId, worktree, 0).status
  }
  const recorded: ConsoleAutoAdvanceStatus[] = []
  const rows = { jobs }
  const ports: ConsoleAutoAdvancePorts = {
    readWorkflow: vi.fn(async () => ({
      ok: true as const,
      data: { workflow_id: workflowId, jobs: rows.jobs }
    })),
    start: vi.fn(async () => ({
      ok: true as const,
      data: {
        jobId: 'job_planning1',
        workflowId,
        cardId: 'btk_localfixture',
        runId: 'run_1',
        dispatchId: 'dispatch_1',
        terminalHandle: null,
        worktreeId: 'wt',
        branch: 'omni/job_planning1',
        state: 'running' as const
      }
    })),
    preference: () => preference,
    record: (_id, status) => {
      recorded.push(status)
      preference = { ...preference, status }
    },
    sanitize: (text) => text.replaceAll('opaque-bearer-sentinel', '[redacted]'),
    warn: vi.fn()
  }
  return {
    ports,
    recorded,
    rows,
    service: new ConsoleAutoAdvance(ports),
    turnOff: () => {
      preference = consoleAutoAdvanceOff(workflowId, worktree)
    },
    turnOn: () => {
      preference = { ...preference, enabled: true }
    }
  }
}

describe('bounded console auto-advance', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('activates one ready local job per cycle and keeps polling every five seconds', async () => {
    const harness = createHarness([
      autoAdvanceJob({ id: 'job_research1', workflowState: 'done', status: 'done' }),
      autoAdvanceJob({ id: 'job_planning1' })
    ])
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.ports.start).toHaveBeenCalledExactlyOnceWith({
      jobId: 'job_planning1',
      workflowId,
      approvedDigest: 'b'.repeat(64),
      worktree
    })
    harness.rows.jobs = [
      autoAdvanceJob({ id: 'job_research1', workflowState: 'done', status: 'done' }),
      autoAdvanceJob({ id: 'job_planning1', workflowState: 'running', status: 'running' })
    ]
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_POLL_MS)
    expect(harness.ports.start).toHaveBeenCalledTimes(1)
    expect(harness.recorded.map((status) => status.state)).toEqual(['activated', 'waiting'])
  })

  it('stops the poll at a human decision and reports the reason once', async () => {
    const harness = createHarness([
      autoAdvanceJob({ id: 'job_approval1', actorType: 'human', canDecide: true })
    ])
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.ports.start).not.toHaveBeenCalled()
    expect(harness.recorded.at(-1)).toMatchObject({
      state: 'stopped',
      reason: 'human_decision',
      jobId: 'job_approval1'
    })
    expect(harness.service.isRunning(workflowId)).toBe(false)
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_POLL_MS * 4)
    expect(harness.ports.readWorkflow).toHaveBeenCalledTimes(1)
  })

  it('stops immediately when the person turns it off mid-poll', async () => {
    const harness = createHarness([
      autoAdvanceJob({ id: 'job_planning1', workflowState: 'running', status: 'running' })
    ])
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.service.isRunning(workflowId)).toBe(true)
    harness.turnOff()
    harness.service.stop(workflowId)
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_POLL_MS * 3)
    expect(harness.ports.readWorkflow).toHaveBeenCalledTimes(1)
    expect(harness.ports.start).not.toHaveBeenCalled()
    expect(harness.service.isRunning(workflowId)).toBe(false)
  })

  it('never activates after the off switch even if a cycle is asked for directly', async () => {
    const harness = createHarness([autoAdvanceJob({ id: 'job_planning1' })])
    harness.turnOff()
    expect(await harness.service.cycle(workflowId)).toMatchObject({ state: 'off' })
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_POLL_MS)
    expect(harness.ports.start).not.toHaveBeenCalled()
    expect(harness.ports.readWorkflow).not.toHaveBeenCalled()
  })

  it('gives up with a visible reason after the ten minute window', async () => {
    const harness = createHarness([
      autoAdvanceJob({ id: 'job_planning1', workflowState: 'running', status: 'running' })
    ])
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_WINDOW_MS + CONSOLE_AUTO_ADVANCE_POLL_MS)
    expect(harness.recorded.at(-1)).toMatchObject({ state: 'stopped', reason: 'timed_out' })
    expect(harness.service.isRunning(workflowId)).toBe(false)
    expect(harness.ports.start).not.toHaveBeenCalled()
  })

  it('stops on a refused activation and keeps the sanitized reason', async () => {
    const harness = createHarness([autoAdvanceJob({ id: 'job_planning1' })])
    vi.mocked(harness.ports.start).mockResolvedValue({
      ok: false,
      error: { code: 'not_ready', message: 'Refused opaque-bearer-sentinel' }
    })
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.recorded.at(-1)).toMatchObject({
      state: 'stopped',
      reason: 'refused',
      detail: 'Refused [redacted]'
    })
    expect(harness.service.isRunning(workflowId)).toBe(false)
  })

  it('does not activate when stopped while the workflow read is pending', async () => {
    const harness = createHarness([autoAdvanceJob({ id: 'job_planning1' })])
    let finish!: (value: Awaited<ReturnType<ConsoleAutoAdvancePorts['readWorkflow']>>) => void
    vi.mocked(harness.ports.readWorkflow).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    harness.turnOff()
    harness.service.stop(workflowId)
    finish({ ok: true, data: { workflow_id: workflowId, jobs: harness.rows.jobs } })
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_POLL_MS)
    expect(harness.ports.start).not.toHaveBeenCalled()
    expect(harness.recorded).toEqual([])
  })

  it('starts a fresh polling generation after off then on during an old read', async () => {
    const harness = createHarness([autoAdvanceJob({ id: 'job_planning1' })])
    let finish!: (value: Awaited<ReturnType<ConsoleAutoAdvancePorts['readWorkflow']>>) => void
    vi.mocked(harness.ports.readWorkflow).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    harness.turnOff()
    harness.service.stop(workflowId)
    harness.turnOn()
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.ports.readWorkflow).toHaveBeenCalledTimes(2)
    expect(harness.ports.start).toHaveBeenCalledTimes(1)
    finish({ ok: true, data: { workflow_id: workflowId, jobs: harness.rows.jobs } })
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_POLL_MS)
    expect(harness.ports.readWorkflow).toHaveBeenCalledTimes(3)
    expect(harness.ports.start).toHaveBeenCalledTimes(1)
  })

  it('does not start a ready job when the deadline passed during its read', async () => {
    const harness = createHarness([autoAdvanceJob({ id: 'job_planning1' })])
    let finish!: (value: Awaited<ReturnType<ConsoleAutoAdvancePorts['readWorkflow']>>) => void
    vi.mocked(harness.ports.readWorkflow).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_WINDOW_MS + 1)
    finish({ ok: true, data: { workflow_id: workflowId, jobs: harness.rows.jobs } })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.ports.start).not.toHaveBeenCalled()
    expect(harness.recorded.at(-1)).toMatchObject({ state: 'stopped', reason: 'timed_out' })
  })

  it('does not overwrite off state after an already requested activation resolves', async () => {
    const harness = createHarness([autoAdvanceJob({ id: 'job_planning1' })])
    let finish!: (value: Awaited<ReturnType<ConsoleAutoAdvancePorts['start']>>) => void
    vi.mocked(harness.ports.start).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    harness.service.begin(workflowId)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.ports.start).toHaveBeenCalledTimes(1)
    harness.turnOff()
    harness.service.stop(workflowId)
    finish({ ok: false, error: { code: 'refused', message: 'Late refusal' } })
    await vi.advanceTimersByTimeAsync(CONSOLE_AUTO_ADVANCE_POLL_MS)
    expect(harness.ports.preference(workflowId).status.state).toBe('off')
    expect(harness.recorded).toEqual([])
  })
})
