// @vitest-environment happy-dom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/sidebar-sessions', () => ({
  buildSidebarSessions: () => [{ paneKey: 'pane-a', customTitle: 'Fix login', label: 'Session' }]
}))

import { useArtifactSessionLinks } from './use-artifact-session-links'

const rows = (): ArtifactListItem[] => [
  {
    artifact: {
      version: 1,
      slug: 'a',
      title: 'A',
      originalFileName: null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '',
      updatedAt: '',
      expiresAt: '',
      byteSize: 1,
      deletedAt: null
    },
    shareUrl: 'https://omnios.example/a/a',
    sessionRef: 'als_a'
  }
]

describe('useArtifactSessionLinks', () => {
  afterEach(() => {
    cleanup()
    rpc.mockReset()
  })

  it('R5: retries a failed session-record read when the rows refresh', async () => {
    rpc
      .mockRejectedValueOnce(new Error('session records timeout'))
      .mockResolvedValueOnce([{ slug: 'a', origin: { paneKey: 'pane-a' } }])
    const { result, rerender } = renderHook(({ items }) => useArtifactSessionLinks(items), {
      initialProps: { items: rows() }
    })
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    expect(result.current.size).toBe(0)
    rerender({ items: rows() })
    await waitFor(() => expect(result.current.get('a')?.title).toBe('Fix login'))
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('reads once when it succeeds, however often the rows change', async () => {
    rpc.mockResolvedValue([])
    const { rerender } = renderHook(({ items }) => useArtifactSessionLinks(items), {
      initialProps: { items: rows() }
    })
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    rerender({ items: rows() })
    rerender({ items: rows() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
