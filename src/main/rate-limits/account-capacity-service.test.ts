import { fetchCodexCapacityEntry } from './codex-capacity-reading'
import type * as ClaudeCapacityReading from './claude-capacity-reading'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountCapacityService } from './account-capacity-service'
import { resolveCapacityRoster } from './account-capacity-roster'
import { fetchClaudeCapacityEntry, type CapacityEntry } from './claude-capacity-reading'
import { RateLimitService } from './service'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'

vi.mock('./codex-capacity-reading', () => ({ fetchCodexCapacityEntry: vi.fn() }))
vi.mock('./account-capacity-roster', () => ({ resolveCapacityRoster: vi.fn() }))
vi.mock('./claude-capacity-reading', async (original) => ({
  ...(await original<typeof ClaudeCapacityReading>()),
  fetchClaudeCapacityEntry: vi.fn()
}))
vi.mock('./account-capacity-readings', () => ({
  AccountCapacityReadings: class {
    readings = new Map<string, ProviderRateLimits>()
    get(key: string) {
      return this.readings.get(key) ?? null
    }
    delete(key: string) {
      this.readings.delete(key)
    }
    set(key: string, value: ProviderRateLimits) {
      this.readings.set(key, value)
      return value
    }
  }
}))
const roster = {
  claudeManagedAccounts: [],
  codexManagedAccounts: [],
  activeClaudeManagedAccountId: null,
  activeCodexManagedAccountId: null
}
const row = (): CapacityEntry => ({
  accountId: null,
  email: null,
  path: '/synthetic/claude',
  launchEnv: { CLAUDE_CONFIG_DIR: '/synthetic/claude' }
})
const reading: ProviderRateLimits = {
  provider: 'claude',
  session: null,
  weekly: null,
  status: 'ok',
  error: null,
  updatedAt: 1
}
const event = {
  configDir: '\\synthetic\\claude\\',
  fiveHour: { used_percentage: 25 },
  sevenDay: null
}

describe('capacity live usage and refresh coordination', () => {
  it('continues status-bar refresh after capacity resolution fails', async () => {
    const service = new RateLimitService()
    service.accountCapacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    vi.mocked(resolveCapacityRoster).mockRejectedValueOnce(new Error('timeout'))
    const fetchAll = vi
      .spyOn(
        service as unknown as { fetchAll: (options: { force: boolean }) => Promise<void> },
        'fetchAll'
      )
      .mockResolvedValue()
    await service.refresh()
    expect(fetchAll).toHaveBeenCalledWith({ force: true })
  })
  it('preserves Retry-After after login', async () => {
    vi.mocked(resolveCapacityRoster).mockResolvedValue({
      claude: [{ ...row(), accountId: 'a' }],
      codex: []
    })
    const capacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    vi.mocked(fetchClaudeCapacityEntry).mockResolvedValueOnce({
      ...reading,
      status: 'error',
      usageMetadata: { retryAtMs: Date.now() + 100000 }
    })
    await capacity.refresh('claude', 'a')
    await capacity.signedIn('claude', 'a')
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledTimes(1)
  })
  it('refreshes only a newly signed-in account', async () => {
    const old = { ...row(), accountId: 'old' }
    const added = { ...row(), accountId: 'new', path: '/new' }
    vi.mocked(resolveCapacityRoster).mockResolvedValueOnce({ claude: [old], codex: [] })
    const service = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    await service.refresh('claude')
    vi.mocked(resolveCapacityRoster).mockResolvedValueOnce({ claude: [old, added], codex: [] })
    vi.mocked(fetchClaudeCapacityEntry).mockClear()
    await service.signedIn('claude')
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledExactlyOnceWith(added, expect.anything())
  })
  it('starts a fresh Codex read after an in-flight pre-reset reading settles', async () => {
    vi.mocked(resolveCapacityRoster).mockResolvedValue({ claude: [], codex: [row()] })
    let finish!: (value: ProviderRateLimits) => void
    vi.mocked(fetchCodexCapacityEntry).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const fresh = { ...reading, provider: 'codex' as const, updatedAt: Date.now() }
    vi.mocked(fetchCodexCapacityEntry).mockResolvedValueOnce(fresh)
    const service = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    const pending = service.active('codex')
    await vi.advanceTimersByTimeAsync(0)
    const reset = service.activeAfterReset()
    finish({ ...fresh, updatedAt: Date.now() - 1000 })
    await pending
    expect(await reset).toBe(fresh)
    expect(fetchCodexCapacityEntry).toHaveBeenCalledTimes(2)
  })
  it('deduplicates shared paths even for forced refreshes', async () => {
    vi.mocked(resolveCapacityRoster).mockResolvedValue({
      claude: [row(), { ...row(), accountId: 'managed' }],
      codex: []
    })
    const capacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    await capacity.refresh('claude', undefined, { force: true })
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledOnce()
  })
  it('bounds account probes and starts independent reads together', async () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({
      ...row(),
      path: `/account-${index}`
    }))
    vi.mocked(resolveCapacityRoster).mockResolvedValue({ claude: entries, codex: [] })
    const releases: (() => void)[] = []
    let active = 0
    let peak = 0
    vi.mocked(fetchClaudeCapacityEntry).mockImplementation(
      () =>
        new Promise((resolve) => {
          active++
          peak = Math.max(peak, active)
          releases.push(() => {
            active--
            resolve(reading)
          })
        })
    )
    const service = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    const refresh = service.refresh('claude')
    await vi.advanceTimersByTimeAsync(0)
    expect(releases).toHaveLength(4)
    for (let index = 0; index < 7; index++) {
      releases[index]()
      await vi.advanceTimersByTimeAsync(0)
    }
    await refresh
    expect(peak).toBe(4)
  })
  it('retries failed resolution immediately', async () => {
    vi.mocked(resolveCapacityRoster).mockRejectedValueOnce(new Error('timeout'))
    const capacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    await expect(capacity.resolve()).rejects.toThrow('timeout')
    await capacity.resolve()
    expect(resolveCapacityRoster).toHaveBeenCalledTimes(2)
  })
  it('rechecks signed-out source health on manual refresh', async () => {
    vi.mocked(resolveCapacityRoster).mockResolvedValueOnce({
      claude: [{ ...row(), launchEnv: null }],
      codex: []
    })
    const capacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    await capacity.resolve()
    await capacity.refreshAll()
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledOnce()
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    vi.mocked(resolveCapacityRoster).mockResolvedValue({ claude: [row()], codex: [] })
    vi.mocked(fetchClaudeCapacityEntry).mockResolvedValue(reading)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  it('normalizes live paths, dedupes pushes and defers OAuth after a newer live reading', async () => {
    const changed = vi.fn()
    const service = new AccountCapacityService(() => roster, '/synthetic', changed)
    await service.refresh('claude')
    vi.mocked(fetchClaudeCapacityEntry).mockClear()
    vi.advanceTimersByTime(300_001)
    expect(service.ingest(event)?.session?.usedPercent).toBe(25)
    changed.mockClear()
    expect(service.ingest(event)).toBeNull()
    expect(changed).not.toHaveBeenCalled()
    await service.refresh('claude')
    expect(fetchClaudeCapacityEntry).not.toHaveBeenCalled()
  })
  it('keeps live readings in the legacy active Claude field', async () => {
    const capacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    await capacity.resolve()
    const service = new RateLimitService()
    service.accountCapacity = capacity
    service.ingestLiveClaudeRateLimits(event)
    expect(service.getState().claude?.session?.usedPercent).toBe(25)
  })
  it('forces recent attempts and readings while preserving Retry-After and pending dedupe', async () => {
    const service = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    vi.mocked(fetchClaudeCapacityEntry).mockResolvedValue({ ...reading, updatedAt: Date.now() })
    await service.refresh('claude')
    await service.refresh('claude')
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledTimes(1)
    await Promise.all([
      service.refresh('claude', undefined, { force: true }),
      service.refresh('claude', undefined, { force: true })
    ])
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledTimes(2)
    vi.mocked(fetchClaudeCapacityEntry).mockResolvedValue({
      ...reading,
      status: 'error',
      updatedAt: 0,
      usageMetadata: { retryAtMs: Date.now() + 1000 }
    })
    await service.refresh('claude', undefined, { force: true })
    await service.refresh('claude', undefined, { force: true })
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1001)
    await service.refresh('claude', undefined, { force: true })
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledTimes(4)
  })
  it('threads manual Refresh through both provider caches', async () => {
    const service = new RateLimitService()
    const capacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    service.accountCapacity = capacity
    const refresh = vi.spyOn(capacity, 'refresh').mockResolvedValue(reading)
    vi.spyOn(service as unknown as { fetchAll(): Promise<void> }, 'fetchAll').mockResolvedValue(
      undefined
    )
    await service.refresh()
    expect(refresh).toHaveBeenCalledWith('claude', undefined, { force: true })
    expect(refresh).toHaveBeenCalledWith('codex', undefined, { force: true })
  })
  it('coalesces an exit refresh with an existing request', async () => {
    let finish!: (value: ProviderRateLimits) => void
    vi.mocked(fetchClaudeCapacityEntry).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const service = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    const pending = service.refresh('claude')
    await vi.advanceTimersByTimeAsync(0)
    service.scheduleExitRefresh('claude', '/synthetic/claude')
    await vi.advanceTimersByTimeAsync(1500)
    expect(fetchClaudeCapacityEntry).toHaveBeenCalledTimes(1)
    finish(reading)
    await pending
  })
  it('does not probe signed-out rows after exit', async () => {
    vi.mocked(resolveCapacityRoster).mockResolvedValue({
      claude: [{ ...row(), launchEnv: null }],
      codex: []
    })
    const service = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    await service.resolve()
    service.scheduleExitRefresh('claude', '/synthetic/claude')
    await vi.advanceTimersByTimeAsync(1500)
    expect(fetchClaudeCapacityEntry).not.toHaveBeenCalled()
  })
  it('pushes completed resolution, fetch and ingest without resolving again', async () => {
    const service = new RateLimitService()
    const capacity = new AccountCapacityService(
      () => roster,
      '/synthetic',
      () => service.pushAccountCapacity()
    )
    service.accountCapacity = capacity
    // Fail promptly if a push accidentally becomes another roster notification.
    vi.mocked(resolveCapacityRoster).mockImplementation(async () => {
      if (vi.mocked(resolveCapacityRoster).mock.calls.length > 2) {
        throw new Error('Recursive roster resolution')
      }
      return { claude: [row()], codex: [] }
    })
    await capacity.refresh('claude')
    capacity.ingest(event)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCapacityRoster).toHaveBeenCalledTimes(1)
    service.notifyAccountsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCapacityRoster).toHaveBeenCalledTimes(2)
  })
  it('caches source health and re-resolves on account notifications', async () => {
    const capacity = new AccountCapacityService(() => roster, '/synthetic', vi.fn())
    await capacity.resolve()
    await capacity.resolve()
    expect(resolveCapacityRoster).toHaveBeenCalledTimes(1)
    const service = new RateLimitService()
    service.accountCapacity = capacity
    service.notifyAccountsChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveCapacityRoster).toHaveBeenCalledTimes(2)
  })
})
