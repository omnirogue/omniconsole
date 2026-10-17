// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchRateLimits: vi.fn(),
  setRateLimitsFromPush: vi.fn(),
  refreshIfStale: vi.fn(),
  fetchInactiveClaudeAccounts: vi.fn(),
  fetchInactiveCodexAccounts: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      fetchRateLimits: mocks.fetchRateLimits,
      setRateLimitsFromPush: mocks.setRateLimitsFromPush
    })
  }
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: vi.fn(),
  watchProviderAccounts: vi.fn()
}))

import { refreshWorkProviderUsage } from './useWorkProviderUsage'

let owner = 0
const nextOwner = () => `usage-owner-${++owner}`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchRateLimits.mockResolvedValue(undefined)
  mocks.refreshIfStale.mockResolvedValue({ claude: { status: 'ok' } })
  mocks.fetchInactiveClaudeAccounts.mockResolvedValue(undefined)
  mocks.fetchInactiveCodexAccounts.mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      rateLimits: {
        refreshIfStale: mocks.refreshIfStale,
        fetchInactiveClaudeAccounts: mocks.fetchInactiveClaudeAccounts,
        fetchInactiveCodexAccounts: mocks.fetchInactiveCodexAccounts
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('refreshWorkProviderUsage', () => {
  it('asks the host for real readings when a surface opens, and at most once a minute', async () => {
    vi.useFakeTimers()
    const key = nextOwner()
    await refreshWorkProviderUsage(key)
    expect(mocks.refreshIfStale).toHaveBeenCalledTimes(1)
    expect(mocks.setRateLimitsFromPush).toHaveBeenCalledWith({ claude: { status: 'ok' } })
    expect(mocks.fetchInactiveClaudeAccounts).not.toHaveBeenCalled()

    vi.advanceTimersByTime(59_000)
    await refreshWorkProviderUsage(key)
    expect(mocks.refreshIfStale).toHaveBeenCalledTimes(1)
    expect(mocks.fetchRateLimits).toHaveBeenCalledTimes(1)
  })

  it('keeps asking the host while a surface stays open, so its readings never go stale', async () => {
    vi.useFakeTimers()
    const key = nextOwner()
    // The open surface's timer fires every minute; readings count as current for six.
    for (let minute = 0; minute <= 10; minute += 1) {
      await refreshWorkProviderUsage(key)
      vi.advanceTimersByTime(60_000)
    }
    expect(mocks.refreshIfStale).toHaveBeenCalledTimes(11)
    expect(mocks.fetchRateLimits).not.toHaveBeenCalled()
  })

  it('reads inactive accounts too on an explicit refresh, at most once a minute', async () => {
    vi.useFakeTimers()
    const key = nextOwner()
    await refreshWorkProviderUsage(key, 'explicit')
    expect(mocks.fetchInactiveClaudeAccounts).toHaveBeenCalledTimes(1)
    expect(mocks.fetchInactiveCodexAccounts).toHaveBeenCalledTimes(1)
    expect(mocks.refreshIfStale).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(61_000)
    await refreshWorkProviderUsage(key, 'explicit')
    expect(mocks.refreshIfStale).toHaveBeenCalledTimes(2)
  })

  it('shares one request per owner and falls back to the cache when the host refuses', async () => {
    mocks.refreshIfStale.mockRejectedValue(new Error('offline'))
    const key = nextOwner()
    const first = refreshWorkProviderUsage(key)
    expect(refreshWorkProviderUsage(key)).toBe(first)
    await first
    expect(mocks.refreshIfStale).toHaveBeenCalledTimes(1)
    expect(mocks.fetchRateLimits).toHaveBeenCalledTimes(1)
    expect(mocks.setRateLimitsFromPush).not.toHaveBeenCalled()
  })
})
