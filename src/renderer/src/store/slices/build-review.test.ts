import { create } from 'zustand'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBuildReviewSlice } from './build-review'
import type { AppState } from '../types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { pipelineFixture } from '../../components/build-review/build-review-test-fixture'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
const rpc = vi.mocked(callRuntimeRpc)
function makeStore() {
  return create<Pick<AppState, 'buildReview' | 'openBuildReviewPage'>>()((...args) => ({
    ...createBuildReviewSlice(...(args as Parameters<typeof createBuildReviewSlice>)),
    openBuildReviewPage: vi.fn()
  }))
}
beforeEach(() => vi.clearAllMocks())
describe('build review slice', () => {
  it('starts inside a workflow conversation without navigating away', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    // Unsaid, the Start is a fleet one: the host is asked for placement support first.
    rpc.mockResolvedValueOnce({ runsOn: ['fleet', 'local'] })
    rpc.mockResolvedValueOnce({ pipeline })
    expect(
      await store
        .getState()
        .buildReview.start(
          { worktree: pipeline.worktree, objective: pipeline.objective },
          { reveal: false }
        )
    ).toEqual(pipeline)
    expect(store.getState().openBuildReviewPage).not.toHaveBeenCalled()
    expect(store.getState().buildReview.pipelinesById[pipeline.id]).toEqual(pipeline)
  })
  it('lists and refreshes a pipeline through the local coordinator', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    expect(store.getState().buildReview.pipelinesListed).toBe(false)
    rpc.mockResolvedValueOnce({ pipelines: [pipeline] })
    await store.getState().buildReview.refreshAll()
    expect(rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'buildReview.list')
    expect(store.getState().buildReview.pipelinesById[pipeline.id]).toEqual(pipeline)
    // The host has answered: a run it did not list is one it no longer has.
    expect(store.getState().buildReview.pipelinesListed).toBe(true)
    rpc.mockResolvedValueOnce({ pipeline: { ...pipeline, stage: 'completed' } })
    await store.getState().buildReview.refreshOne(pipeline.id)
    expect(rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'buildReview.show', { id: pipeline.id })
    expect(store.getState().buildReview.pipelinesById[pipeline.id].stage).toBe('completed')
  })
  it('starts, selects, navigates, cancels and replies with contract params', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    rpc.mockResolvedValueOnce({ runsOn: ['fleet', 'local'] })
    rpc.mockResolvedValue({ pipeline })
    store.getState().buildReview.openStartDialog(pipeline.worktree)
    expect(store.getState().buildReview.startDialog).toEqual({
      open: true,
      worktree: pipeline.worktree
    })
    const request = { worktree: pipeline.worktree, objective: pipeline.objective }
    await store.getState().buildReview.start(request)
    expect(rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'buildReview.start', request)
    expect(store.getState().buildReview.selectedPipelineId).toBe(pipeline.id)
    expect(store.getState().buildReview.startDialog.open).toBe(false)
    expect(store.getState().openBuildReviewPage).toHaveBeenCalledOnce()
    await store.getState().buildReview.cancel(pipeline.id)
    expect(rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'buildReview.cancel', {
      id: pipeline.id
    })
    await store.getState().buildReview.reply(pipeline.id, 'message-1', 'Yes')
    expect(rpc).toHaveBeenLastCalledWith({ kind: 'local' }, 'buildReview.reply', {
      id: pipeline.id,
      messageId: 'message-1',
      body: 'Yes'
    })
  })
  it('preserves live snapshots on transport errors and rejects failed starts', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    rpc.mockRejectedValueOnce(new Error('Disconnected'))
    await store.getState().buildReview.refreshAll()
    // A list that never arrived says nothing about which runs the host has.
    expect(store.getState().buildReview.pipelinesListed).toBe(false)
    rpc.mockResolvedValueOnce({ pipelines: [pipeline] })
    await store.getState().buildReview.refreshAll()
    rpc.mockRejectedValue(new Error('Disconnected'))
    await store.getState().buildReview.refreshOne(pipeline.id)
    expect(store.getState().buildReview.pipelinesById[pipeline.id].stage).toBe('reviewing')
    expect(store.getState().buildReview.error).toContain('Disconnected')
    await expect(
      store.getState().buildReview.start({ worktree: pipeline.worktree, objective: 'Build' })
    ).rejects.toThrow('Disconnected')
    expect(store.getState().openBuildReviewPage).not.toHaveBeenCalled()
  })
  it('does not let an older list overwrite a newer push snapshot', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    let resolveList!: (value: unknown) => void
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve
        })
    )
    const refresh = store.getState().buildReview.refreshAll()
    rpc.mockResolvedValueOnce({
      pipeline: { ...pipeline, stage: 'completed', updatedAt: '2026-09-07T13:00:00Z' }
    })
    await store.getState().buildReview.refreshOne(pipeline.id)
    resolveList({ pipelines: [pipeline] })
    await refresh
    expect(store.getState().buildReview.pipelinesById[pipeline.id].stage).toBe('completed')
  })
})

describe('build review slice placement support', () => {
  const request = { worktree: 'id:repo::/workspace', objective: 'Build', runsOn: 'fleet' as const }

  it('asks the host for placement support before a fleet Start and refuses by name where it is unknown', async () => {
    const store = makeStore()
    rpc.mockRejectedValueOnce(
      Object.assign(new Error('Unknown method: buildReview.placementSupport'), {
        code: 'method_not_found'
      })
    )
    await expect(store.getState().buildReview.start(request)).rejects.toThrow(
      /from before fleet placement and would run a fleet request on this computer/
    )
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith({ kind: 'local' }, 'buildReview.placementSupport')
  })

  it('starts on a host that answers the support method', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    rpc.mockResolvedValueOnce({ runsOn: ['fleet', 'local'] })
    rpc.mockResolvedValueOnce({ pipeline })
    await expect(store.getState().buildReview.start(request, { reveal: false })).resolves.toEqual(
      pipeline
    )
    expect(rpc).toHaveBeenNthCalledWith(1, { kind: 'local' }, 'buildReview.placementSupport')
    expect(rpc).toHaveBeenNthCalledWith(2, { kind: 'local' }, 'buildReview.start', request)
  })

  it('refuses a named host by name when the support answer lacks hosts, without sending the Start', async () => {
    const store = makeStore()
    rpc.mockResolvedValueOnce({ runsOn: ['fleet', 'local'] })
    await expect(
      store.getState().buildReview.start({ ...request, runsOnHost: 'mw0004' })
    ).rejects.toThrow(/cannot run Build \+ Review on a named host/)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('sends a named-host Start where the host answers hosts: true', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    const named = { ...request, runsOnHost: 'mw0004', runsOnHostId: 'ssh:t1' }
    rpc.mockResolvedValueOnce({ runsOn: ['fleet', 'local'], hosts: true })
    rpc.mockResolvedValueOnce({ pipeline })
    await store.getState().buildReview.start(named, { reveal: false })
    expect(rpc).toHaveBeenNthCalledWith(2, { kind: 'local' }, 'buildReview.start', named)
  })

  it('never asks for support before an explicit local Start', async () => {
    const store = makeStore()
    const pipeline = pipelineFixture()
    rpc.mockResolvedValueOnce({ pipeline })
    await store.getState().buildReview.start({ ...request, runsOn: 'local' }, { reveal: false })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith({ kind: 'local' }, 'buildReview.start', {
      ...request,
      runsOn: 'local'
    })
  })
})

describe('build review slice placement support, degraded answers', () => {
  const request = { worktree: 'id:repo::/workspace', objective: 'Build', runsOn: 'fleet' as const }

  it('refuses a host whose support answer is not the contract', async () => {
    const store = makeStore()
    rpc.mockResolvedValueOnce({ pipeline: pipelineFixture() })
    await expect(store.getState().buildReview.start(request)).rejects.toThrow(
      /from before fleet placement and would run a fleet request on this computer/
    )
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('refuses by name when the probe never answers, instead of hanging the Start', async () => {
    vi.useFakeTimers()
    try {
      const store = makeStore()
      rpc.mockImplementationOnce(() => new Promise(() => {}))
      const started = store.getState().buildReview.start(request)
      const outcome = started.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(outcome).resolves.toMatch(/did not say whether it places fleet runs within 5 s/)
      expect(rpc).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
