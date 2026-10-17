import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const graph = vi.hoisted(() => ({ listeners: new Set<() => void>() }))
vi.mock('./sync-runtime-graph', () => ({
  getRuntimeGraphRendererGeneration: () => 'renderer:test',
  onRuntimeGraphSynced: (listener: () => void) => {
    graph.listeners.add(listener)
    return () => graph.listeners.delete(listener)
  }
}))

import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { startSessionWorkflowRecordPublication } from './session-workflow-record-publication'

const WT = 'repo::/work'

function workflowTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: WT,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    localWorkflow: { preset: 'council', prompt: 'Q', executionId: `run-${id}` }
  }
}

describe('publishing this window’s workflow records (step 9)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState({
      tabsByWorktree: { [WT]: [workflowTab('one')] },
      hydrationSucceeded: true
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Minor (c): a refused send (graph not synced yet, a reload) is retried with bounded backoff.
  it('retries a refused publication with backoff, under its graph’s renderer generation', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('session_workflow_records_publisher_not_current'))
      .mockRejectedValueOnce(new Error('session_workflow_records_publisher_not_current'))
      .mockResolvedValue(undefined)
    const stop = startSessionWorkflowRecordPublication(send)

    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenLastCalledWith({
      rendererGeneration: 'renderer:test',
      recordsByWorktree: { [WT]: [expect.objectContaining({ tabId: 'one', runId: 'run-one' })] },
      complete: true
    })
    stop()
  })

  // Minor (m5): main refuses until it holds this renderer's graph; its sync retries at once.
  it('retries a refused publication as soon as the graph sync lands', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('session_workflow_records_publisher_not_current'))
      .mockResolvedValue(undefined)
    const stop = startSessionWorkflowRecordPublication(send)
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)

    for (const listener of graph.listeners) {
      listener()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(2)
    // Accepted: a later graph sync, or the abandoned backoff timer, sends nothing more.
    for (const listener of graph.listeners) {
      listener()
    }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(send).toHaveBeenCalledTimes(2)
    stop()
    expect(graph.listeners.size).toBe(0)
  })

  // Minor (m2): a degraded startup restored no sessions, so its set is unknown, not empty.
  it('publishes an incomplete set from a window whose startup was degraded', async () => {
    useAppStore.setState({ hydrationSucceeded: false, tabsByWorktree: {} })
    const send = vi.fn().mockResolvedValue(undefined)
    const stop = startSessionWorkflowRecordPublication(send)
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledWith({
      rendererGeneration: 'renderer:test',
      recordsByWorktree: {},
      complete: false
    })
    stop()
  })

  it('republishes once per change, and not at all after it stops', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const stop = startSessionWorkflowRecordPublication(send)
    await vi.advanceTimersByTimeAsync(0)
    useAppStore.setState({ tabsByWorktree: { [WT]: [workflowTab('one'), workflowTab('two')] } })
    useAppStore.setState({ tabsByWorktree: { [WT]: [workflowTab('one'), workflowTab('two')] } })
    await vi.advanceTimersByTimeAsync(200)
    expect(send).toHaveBeenCalledTimes(2)
    stop()
    useAppStore.setState({ tabsByWorktree: {} })
    await vi.advanceTimersByTimeAsync(200)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
