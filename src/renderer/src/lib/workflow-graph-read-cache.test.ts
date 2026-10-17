import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  clearWorkflowGraphReads,
  readWorkflowGraph,
  refreshWorkflowGraph
} from './workflow-graph-read-cache'
const getWorkflow = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  clearWorkflowGraphReads('account')
  getWorkflow.mockReset().mockImplementation(async ({ workflowId }) => ({
    ok: true,
    data: { workflow_id: workflowId, jobs: [] }
  }))
  vi.stubGlobal('window', { api: { consoleWorkflows: { getWorkflow } } })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('shares identity/digest within a tick, including detail reads without a digest', async () => {
  const first = readWorkflowGraph('account', 'wf_one', 'digest1')
  expect(readWorkflowGraph('account', 'wf_one', 'digest1')).toBe(first)
  expect(readWorkflowGraph('account', 'wf_one')).toBe(first)
  await first
  expect(getWorkflow).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  await readWorkflowGraph('account', 'wf_one', 'digest1')
  expect(getWorkflow).toHaveBeenCalledTimes(2)
  await readWorkflowGraph('account', 'wf_one', 'digest2')
  expect(getWorkflow).toHaveBeenCalledTimes(3)
})
it('caps the graph family at one in-flight outbound call across identities', async () => {
  let release!: (value: unknown) => void
  getWorkflow.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const first = readWorkflowGraph('account', 'wf_one', 'one')
  const next = readWorkflowGraph('account', 'wf_two', 'two')
  await vi.advanceTimersByTimeAsync(0)
  expect(getWorkflow).toHaveBeenCalledTimes(1)
  release({ ok: true, data: { workflow_id: 'wf_one', jobs: [] } })
  await Promise.all([first, next])
  expect(getWorkflow).toHaveBeenCalledTimes(2)
})
it('isolates accounts and retries a failed read on the next tick', async () => {
  getWorkflow.mockRejectedValueOnce(new Error('offline'))
  await expect(readWorkflowGraph('account', 'wf_one', 'one')).rejects.toThrow('offline')
  await expect(readWorkflowGraph('account', 'wf_one', 'one')).rejects.toThrow('offline')
  expect(getWorkflow).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  await readWorkflowGraph('account', 'wf_one', 'one')
  await readWorkflowGraph('another-account', 'wf_one', 'one')
  expect(getWorkflow).toHaveBeenCalledTimes(3)
})
it('shares a cold detail read with the same graph subsequently identified by the fleet digest', async () => {
  const detail = readWorkflowGraph('account', 'wf_one')
  const fleet = readWorkflowGraph('account', 'wf_one', 'digest1')
  await Promise.all([detail, fleet])
  expect(getWorkflow).toHaveBeenCalledTimes(1)
})
it('retains each identity/digest separately within a tick', async () => {
  const first = await readWorkflowGraph('account', 'wf_one', 'digest1')
  await readWorkflowGraph('account', 'wf_one', 'digest2')
  expect(await readWorkflowGraph('account', 'wf_one', 'digest1')).toBe(first)
  expect(getWorkflow).toHaveBeenCalledTimes(2)
})

it('an explicit refresh bypasses this tick and replaces the cached status', async () => {
  const old = await readWorkflowGraph('account', 'wf_one', 'digest1')
  getWorkflow.mockResolvedValue({
    ok: true,
    data: { workflow_id: 'wf_one', jobs: [{ status: 'done' }] }
  })
  const fresh = await refreshWorkflowGraph('account', 'wf_one')
  expect(fresh).not.toBe(old)
  expect(fresh.jobs).toEqual([{ status: 'done' }])
  expect(getWorkflow).toHaveBeenCalledTimes(2)
  expect(await readWorkflowGraph('account', 'wf_one', 'digest1')).toBe(fresh)
  expect(await readWorkflowGraph('account', 'wf_one')).toBe(fresh)
  expect(getWorkflow).toHaveBeenCalledTimes(2)
})
it('coalesces explicit refreshes while retaining the graph family concurrency cap', async () => {
  let finish!: (value: unknown) => void
  getWorkflow.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const old = readWorkflowGraph('account', 'wf_one', 'digest1')
  await vi.advanceTimersByTimeAsync(0)
  const fresh = refreshWorkflowGraph('account', 'wf_one')
  expect(refreshWorkflowGraph('account', 'wf_one')).toBe(fresh)
  await vi.advanceTimersByTimeAsync(0)
  expect(getWorkflow).toHaveBeenCalledTimes(1)
  finish({ ok: true, data: { workflow_id: 'wf_one', jobs: [] } })
  await Promise.all([old, fresh])
  expect(getWorkflow).toHaveBeenCalledTimes(2)
})
