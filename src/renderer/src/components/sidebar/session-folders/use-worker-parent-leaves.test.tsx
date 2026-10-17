// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkerLineageResult } from '../../../../../shared/worker-lineage'
import { useWorkerParentLeaves } from './use-worker-parent-leaves'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ terminalLayoutsByTabId: {}, tabsByWorktree: {} })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

afterEach(cleanup)

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const leaf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

it('ignores an older lineage poll that resolves after the explicit refresh', async () => {
  const older = deferred<WorkerLineageResult>()
  const newer = deferred<WorkerLineageResult>()
  vi.mocked(callRuntimeRpc).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  const hook = renderHook(() => useWorkerParentLeaves())
  act(() => {
    window.dispatchEvent(new Event('omni.worker-lineage-refresh'))
  })

  await act(async () => {
    newer.resolve({
      links: [
        {
          parentPaneKey: `tab-4:${leaf(4)}`,
          child: { kind: 'pane', paneKey: `tab-2:${leaf(2)}` },
          dispatchedAt: 1_000_000_000
        }
      ]
    })
  })
  await waitFor(() => expect(hook.result.current.parents.get(leaf(2))).toBe(leaf(4)))

  await act(async () => {
    older.resolve({
      links: [
        {
          parentPaneKey: `tab-3:${leaf(3)}`,
          child: { kind: 'pane', paneKey: `tab-2:${leaf(2)}` },
          dispatchedAt: 1_000_000_000
        }
      ]
    })
  })
  expect(hook.result.current.parents.get(leaf(2))).toBe(leaf(4))
})
