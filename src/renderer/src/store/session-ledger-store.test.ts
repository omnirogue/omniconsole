// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => `${key}:profile`,
  readPersonalView: (storage: Storage, key: string) => storage.getItem(`${key}:profile`)
}))
import { createSessionLedgerStore } from './session-ledger-store'
import { createLocalSessionLedgerStorage } from './session-ledger-storage'
import {
  ledgerApi,
  memoryStorage,
  result,
  row
} from '@/components/sidebar/team-sessions/session-ledger-test-fixtures'

const flush = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})
describe('ledger polling', () => {
  it('switches 30s / 5min reads with one timer and cleans up repeated mounts', async () => {
    vi.useFakeTimers()
    const api = ledgerApi()
    const store = createSessionLedgerStore(
      memoryStorage(),
      () => api,
      async () => 'me'
    )
    const stop = store.getState().start()
    await flush()
    expect(vi.getTimerCount()).toBe(1)
    vi.mocked(api.now).mockClear()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(api.now).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.now).toHaveBeenCalledExactlyOnceWith('live')
    store.getState().setTeamTabMounted(true)
    await flush()
    vi.mocked(api.now).mockClear()
    store.getState().setTeamTabMounted(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.now).toHaveBeenCalledTimes(2)
    expect(api.now).toHaveBeenCalledWith('today')
    store.getState().setTeamTabMounted(false)
    store.getState().setTeamTabMounted(false)
    vi.mocked(api.now).mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.now).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('counts only other employees live rows', async () => {
    const api = ledgerApi({
      now: vi
        .fn()
        .mockResolvedValue(
          result([row('mine', { employee_id: 'me' }), row('other'), row('old', { state: 'done' })])
        )
    })
    const store = createSessionLedgerStore(
      memoryStorage(),
      () => api,
      async () => 'me'
    )
    await store.getState().refresh()
    expect(store.getState().badgeCount).toBe(1)
  })
  it('does not guess a count when the current employee is unknown', async () => {
    const store = createSessionLedgerStore(
      memoryStorage(),
      () => ledgerApi({ now: vi.fn().mockResolvedValue(result([row('other')])) }),
      async () => null
    )
    await store.getState().refresh()
    expect(store.getState().badgeCount).toBe(0)
  })
  it('drops responses from an old profile and clears its rows and preferences', async () => {
    let resolve!: (value: ReturnType<typeof result>) => void
    const api = ledgerApi({
      now: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done
            })
        )
        .mockResolvedValue(result())
    })
    const store = createSessionLedgerStore(
      memoryStorage(),
      () => api,
      async () => 'me'
    )
    const stop = store.getState().start()
    stop()
    const stopAgain = store.getState().start()
    await flush()
    resolve(result([row('old-profile')]))
    await flush()
    expect(store.getState().live).toEqual(result())
    stopAgain()
  })
})
describe('ledger preferences', () => {
  it('persists mute through the API and reads back its authoritative list', async () => {
    const api = ledgerApi({ mutedRepos: vi.fn().mockResolvedValue(['repo', 'already-muted']) })
    const store = createSessionLedgerStore(memoryStorage(), () => api)
    await store.getState().muteRepo('repo')
    expect(api.muteRepo).toHaveBeenCalledWith('repo', true)
    expect([...store.getState().muted]).toEqual(['repo', 'already-muted'])
  })
  it('uses profile storage without preload and later adopts API preferences', async () => {
    const storage = createLocalSessionLedgerStorage()
    let api: ReturnType<typeof ledgerApi> | undefined
    const store = createSessionLedgerStore(
      storage,
      () => api,
      async () => 'me'
    )
    await store.getState().muteRepo('standalone')
    expect(storage.load('muted-repos')).toEqual(['standalone'])
    expect(localStorage.getItem('session-ledger-muted-repos:profile')).toBe('["standalone"]')
    api = ledgerApi({ mutedRepos: vi.fn().mockResolvedValue(['authoritative']) })
    await store.getState().refresh()
    expect([...store.getState().muted]).toEqual(['authoritative'])
  })
  it('deduplicates local/peer/day keys and reloads across store instances', () => {
    const storage = memoryStorage()
    const store = createSessionLedgerStore(storage, () => undefined)
    store.getState().markSeenPeerToday('a', 'peer', '2026-09-13')
    store.getState().markSeenPeerToday('a', 'peer', '2026-09-13')
    expect(store.getState().seen.size).toBe(1)
    expect(store.getState().hasSeenPeerToday('a', 'peer', '2026-09-14')).toBe(false)
    expect(store.getState().hasSeenPeerToday('a', 'another', '2026-09-13')).toBe(false)
    expect(store.getState().hasSeenPeerToday('c', 'peer', '2026-09-13')).toBe(false)
    store.getState().markSeenPeerToday('a', 'peer', '2026-09-14')
    store.getState().markSeenPeerToday('a', 'another', '2026-09-13')
    const restored = createSessionLedgerStore(storage, () => undefined)
    const stop = restored.getState().start()
    expect(restored.getState().seen.size).toBe(3)
    stop()
  })
  it('scopes the daily collision banner to each local session', async () => {
    const a = { paneId: 'pane-a', ledgerId: 'a', attemptId: 'a-1', repo: 'repo' }
    const c = { paneId: 'pane-c', ledgerId: 'c', attemptId: 'c-1', repo: 'repo' }
    const b = { ledger_id: 'b', employee_id: 'other', reason: 'other is on the same file' }
    const api = ledgerApi({
      now: vi.fn().mockResolvedValue(result([row('b', { employee_id: 'other' })])),
      localSessions: vi.fn().mockResolvedValue([a]),
      peers: vi.fn().mockResolvedValue({ ok: true, peers: [b] })
    })
    const store = createSessionLedgerStore(
      memoryStorage(),
      () => api,
      async () => 'me'
    )
    await store.getState().refresh()
    expect(store.getState().collisions.map((item) => item.local.ledgerId)).toEqual(['a'])
    vi.mocked(api.localSessions).mockResolvedValue([a, c])
    await store.getState().refresh()
    expect(store.getState().collisions.map((item) => item.local.ledgerId)).toEqual(['a', 'c'])
    await store.getState().refresh()
    expect(store.getState().collisions).toHaveLength(2)
    // A new attempt of C keeps its ledger id, so the day dedupe does not reset.
    vi.mocked(api.localSessions).mockResolvedValue([a, { ...c, attemptId: 'c-2' }])
    await store.getState().refresh()
    expect(store.getState().collisions).toHaveLength(2)
    expect([...store.getState().seen].sort()).toEqual(['a:b:2026-09-13', 'c:b:2026-09-13'])
  })
  it('ignores persisted entries in the old peer/day shape', async () => {
    const storage = memoryStorage()
    storage.save('seen-peers', ['b:2026-09-13'])
    const api = ledgerApi({
      now: vi.fn().mockResolvedValue(result([row('b', { employee_id: 'other' })])),
      localSessions: vi
        .fn()
        .mockResolvedValue([{ paneId: 'pane-a', ledgerId: 'a', attemptId: 'a-1', repo: 'repo' }]),
      peers: vi
        .fn()
        .mockResolvedValue({ ok: true, peers: [{ ledger_id: 'b', reason: 'same file' }] })
    })
    const store = createSessionLedgerStore(
      storage,
      () => api,
      async () => 'me'
    )
    const stop = store.getState().start()
    await flush()
    expect(store.getState().collisions).toHaveLength(1)
    stop()
  })
})

it('does not overlap slow roster requests on timer ticks', async () => {
  vi.useFakeTimers()
  let resolve!: (value: ReturnType<typeof result>) => void
  const api = ledgerApi({
    now: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue(result())
  })
  const store = createSessionLedgerStore(
    memoryStorage(),
    () => api,
    async () => 'me'
  )
  const stop = store.getState().start()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(api.now).toHaveBeenCalledTimes(1)
  resolve(result([row('slow-peer')]))
  await flush()
  expect(store.getState().badgeCount).toBe(1)
  stop()
})
