import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimitSlice } from './rate-limits'
import type { AppState } from '../types'

function createRateLimitStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) =>
    createRateLimitSlice(...(args as Parameters<typeof createRateLimitSlice>))
  ) as unknown as StoreApi<AppState>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createRateLimitSlice', () => {
  it('initializes Antigravity usage with a stable pending key', () => {
    const store = createRateLimitStore()

    expect(store.getState().rateLimits.antigravity).toBeNull()
  })

  it('reports refresh failure while preserving the last snapshot, then recovers', async () => {
    const store = createRateLimitStore()
    const previous = store.getState().rateLimits
    const refreshed = { ...previous, grokAuthConfigured: true }
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(refreshed)
    vi.stubGlobal('window', { api: { rateLimits: { refresh } } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(store.getState().refreshRateLimits()).resolves.toBe(false)
    expect(store.getState().rateLimits).toBe(previous)
    await expect(store.getState().refreshRateLimits()).resolves.toBe(true)
    expect(store.getState().rateLimits).toBe(refreshed)
  })
})
