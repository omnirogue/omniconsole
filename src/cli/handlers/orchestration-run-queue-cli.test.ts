import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunQueueSummary } from '../../shared/orchestration-run-queue'
import { ORCHESTRATION_RUN_QUEUE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { printResult } from '../format'
import { ORCHESTRATION_HANDLERS } from './orchestration'
import { formatRunQueue } from './orchestration/run-queue-format'

const QUEUE: RunQueueSummary = {
  runId: 'run_1',
  generatedAt: '2026-10-03T23:30:00.000Z',
  taskCounts: { dispatched: 1, failed: 1, completed: 4 },
  omitted: 2,
  limit: 2,
  rows: [
    {
      taskId: 'task_a',
      title: 'Notifications lane',
      taskStatus: 'failed',
      attempts: 2,
      dispatch: {
        id: 'ctx_a',
        status: 'failed',
        workerState: 'failed',
        stage: 'input_accepted_stalled',
        lastError: 'no report within 60 s',
        dispatchedAt: null,
        lastHeartbeatAt: null,
        updatedAt: null,
        terminalHandle: 'term_a',
        server: 'Mac Studio'
      },
      session: { status: 'live' },
      openQuestions: 0,
      attention: 'failed-session-live',
      detail: 'The Dispatch failed (input_accepted_stalled) but its session is live.'
    },
    {
      taskId: 'task_b',
      title: 'Not started',
      taskStatus: 'ready',
      attempts: 0,
      dispatch: null,
      session: null,
      openQuestions: 0,
      attention: 'not-started',
      detail: 'No worker has been started for it.'
    }
  ]
}

async function runShow(flags: [string, string | boolean][]): Promise<void> {
  await ORCHESTRATION_HANDLERS['orchestration run-show']!({
    flags: new Map<string, string | boolean>(flags),
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: true
  } as never)
}

describe('orchestration run-show --queue CLI', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('keeps a plain show to one call with the original params', async () => {
    callMock.mockResolvedValueOnce({ result: { run: { id: 'run_1', objective: 'Work' } } })
    await runShow([['id', 'run_1']])
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('orchestration.runShow', { id: 'run_1' })
  })

  it('asks for the queue only from a runtime that advertises it', async () => {
    callMock
      .mockResolvedValueOnce({
        result: { capabilities: [ORCHESTRATION_RUN_QUEUE_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        result: { run: { id: 'run_1', objective: 'Work' }, queue: QUEUE }
      })
    await runShow([
      ['id', 'run_1'],
      ['queue', true],
      ['limit', '2']
    ])
    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.runShow', {
      id: 'run_1',
      queue: true,
      limit: 2
    })
  })

  it('refuses on an older runtime instead of printing an empty queue', async () => {
    callMock.mockResolvedValueOnce({ result: { capabilities: ['orchestration.contract.v1'] } })
    await expect(
      runShow([
        ['id', 'run_1'],
        ['queue', true]
      ])
    ).rejects.toThrow('does not support the Run queue summary')
    expect(callMock).toHaveBeenCalledTimes(1)
    await expect(
      runShow([
        ['id', 'run_1'],
        ['limit', '5']
      ])
    ).rejects.toThrow('--limit requires --queue')
  })

  it('prints the Dispatch and the session as separate facts', () => {
    const text = formatRunQueue('Three production lanes', QUEUE)
    expect(text).toContain('run_1 Three production lanes')
    expect(text).toContain('Tasks: 1 dispatched, 1 failed, 4 completed.')
    expect(text).toContain('[failed-session-live] task_a Notifications lane')
    expect(text).toContain(
      'dispatch ctx_a failed (failed/input_accepted_stalled) · session live on Mac Studio · attempt 2'
    )
    expect(text).toContain('[not-started] task_b Not started\n    no dispatch')
    expect(text).toContain('2 more unfinished Task(s) not shown')
    expect(formatRunQueue('Done', { ...QUEUE, rows: [], omitted: 0 })).toContain(
      'Nothing is unfinished.'
    )
  })
})
