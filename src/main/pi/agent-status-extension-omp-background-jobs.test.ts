import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

type Posted = {
  hook_event_name: string
  background_task_count?: number
  background_tasks_unknown?: boolean
}

function posted(fetchMock: ReturnType<typeof vi.fn>): Posted[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload as Posted)
}

function jobsContext(running: () => unknown[]) {
  return {
    isIdle: () => true,
    getAsyncJobSnapshot: () => ({ running: running() }),
    sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => '/s/1.jsonl' }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OMP background jobs at turn end', () => {
  it('reports the running async jobs, then settles once they finish', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    let running: unknown[] = [{ id: 'bash-1' }, { id: 'bash-2' }]
    const context = jobsContext(() => running)

    await harness.callHook('agent_start', undefined, context)
    await harness.callHook('agent_end', {}, context)
    await vi.advanceTimersByTimeAsync(0)
    expect(posted(harness.fetchMock).at(-1)).toMatchObject({
      hook_event_name: 'agent_end',
      background_task_count: 2
    })

    running = [{ id: 'bash-2' }]
    await vi.advanceTimersByTimeAsync(5_000)
    expect(posted(harness.fetchMock).at(-1)).toMatchObject({ background_task_count: 1 })

    running = []
    await vi.advanceTimersByTimeAsync(5_000)
    const last = posted(harness.fetchMock).at(-1)
    expect(last?.hook_event_name).toBe('agent_end')
    expect(last?.background_task_count).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('posts nothing new while the count holds, and stops watching when a turn starts', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const context = jobsContext(() => [{ id: 'bash-1' }])

    await harness.callHook('agent_end', {}, context)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(posted(harness.fetchMock).map((p) => p.background_task_count)).toEqual([1])

    await harness.callHook('agent_start', undefined, context)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(posted(harness.fetchMock).map((p) => p.hook_event_name)).toEqual([
      'agent_end',
      'agent_start'
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renews an unchanged count, so a post lost to a receiver restart is repaired', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook(
      'agent_end',
      {},
      jobsContext(() => [{ id: 'bash-1' }])
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(posted(harness.fetchMock).map((p) => p.background_task_count)).toEqual([1, 1])
  })

  it('keeps the last count while the snapshot cannot be read, never settling on no evidence', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    let read: () => unknown[] = () => [{ id: 'bash-1' }]
    const context = {
      isIdle: () => true,
      getAsyncJobSnapshot: () => ({ running: read() }),
      sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => '/s/1.jsonl' }
    }
    await harness.callHook('agent_end', {}, context)
    read = () => {
      throw new Error('busy')
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(posted(harness.fetchMock).map((p) => p.background_task_count)).toEqual([1])
    expect(vi.getTimerCount()).toBe(1)
    read = () => []
    await vi.advanceTimersByTimeAsync(5_000)
    expect(posted(harness.fetchMock).at(-1)?.background_task_count).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops watching when the session shuts down', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook(
      'agent_end',
      {},
      jobsContext(() => [{ id: 'bash-1' }])
    )
    await harness.callHook('session_shutdown')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a plain turn end when OMP has no job manager', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('agent_end', {}, { isIdle: () => true })
    await vi.advanceTimersByTimeAsync(0)
    expect(posted(harness.fetchMock)).toEqual([
      expect.not.objectContaining({ background_task_count: expect.anything() })
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports an unreadable first snapshot as an unknown count, never as done, until it reads', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    let read: () => unknown[] = () => {
      throw new Error('busy')
    }
    const context = {
      isIdle: () => true,
      getAsyncJobSnapshot: () => ({ running: read() }),
      sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => '/s/1.jsonl' }
    }
    await harness.callHook('agent_end', {}, context)
    await vi.advanceTimersByTimeAsync(0)
    expect(posted(harness.fetchMock)).toEqual([
      expect.objectContaining({ hook_event_name: 'agent_end', background_tasks_unknown: true })
    ])
    expect(posted(harness.fetchMock)[0]?.background_task_count).toBeUndefined()
    read = () => []
    await vi.advanceTimersByTimeAsync(5_000)
    const last = posted(harness.fetchMock).at(-1)
    expect(posted(harness.fetchMock)).toHaveLength(2)
    expect(last?.hook_event_name).toBe('agent_end')
    expect(last?.background_tasks_unknown).toBeUndefined()
    expect(last?.background_task_count).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off rather than giving up while the first snapshot stays unreadable', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    let read: () => unknown[] = () => {
      throw new Error('busy')
    }
    const context = {
      isIdle: () => true,
      getAsyncJobSnapshot: () => ({ running: read() }),
      sessionManager: { getSessionId: () => 'session-1', getSessionFile: () => '/s/1.jsonl' }
    }
    await harness.callHook('agent_end', {}, context)
    // Twelve unreadable polls, then the slower pace; the watch never lapses while it cannot read.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(posted(harness.fetchMock)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    read = () => [{ id: 'bash-1' }]
    await vi.advanceTimersByTimeAsync(60_000)
    expect(posted(harness.fetchMock).at(-1)).toMatchObject({ background_task_count: 1 })
    expect(posted(harness.fetchMock).at(-1)?.background_tasks_unknown).toBeUndefined()
  })
})
