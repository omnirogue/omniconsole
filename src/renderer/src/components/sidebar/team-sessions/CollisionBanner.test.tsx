// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
vi.mock('@/lib/session-ledger-console', () => ({ openSessionLedgerConsole: vi.fn() }))
import { openSessionLedgerConsole } from '@/lib/session-ledger-console'
import { createSessionLedgerStore } from '@/store/session-ledger-store'
import { CollisionBanner } from './CollisionBanner'
import { ledgerApi, memoryStorage, result, row } from './session-ledger-test-fixtures'
const local = { paneId: 'pane', ledgerId: 'mine', attemptId: 'attempt', repo: 'local-repo' }
const reason = 'Alice is on the same branch, 4 shared files'
function setup() {
  const api = ledgerApi({
    now: vi.fn().mockResolvedValue(result([row('peer')])),
    localSessions: vi.fn().mockResolvedValue([local]),
    peers: vi.fn().mockResolvedValue({
      ok: true,
      peers: [
        {
          ledger_id: 'peer',
          reason,
          shared_files: ['src/a.ts', 'C:\\src\\b.ts', 'src/c.ts', 'src/d.ts']
        }
      ]
    })
  })
  const store = createSessionLedgerStore(
    memoryStorage(),
    () => api,
    async () => 'me'
  )
  return { api, store }
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})
it('preserves the exact server reason and appends at most three file basenames', async () => {
  const { store } = setup()
  await store.getState().refresh()
  render(<CollisionBanner store={store} />)
  expect(screen.getByText(`${reason} · a.ts, b.ts, c.ts`)).toBeTruthy()
  expect(screen.queryByText(/d\.ts/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open in console' }))
  expect(openSessionLedgerConsole).toHaveBeenCalledWith('peer')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss collision notice' }))
  expect(screen.queryByRole('status')).toBeNull()
})
it('renders a reason without a file suffix unchanged', async () => {
  const { store, api } = setup()
  vi.mocked(api.peers).mockResolvedValue({ ok: true, peers: [{ ledger_id: 'peer', reason }] })
  await store.getState().refresh()
  render(<CollisionBanner store={store} />)
  expect(screen.getByText(reason)).toBeTruthy()
})
it('mutes the local session repo and dismisses its banner', async () => {
  const { store, api } = setup()
  await store.getState().refresh()
  render(<CollisionBanner store={store} />)
  fireEvent.click(screen.getByRole('button', { name: 'Mute this repo' }))
  expect(api.muteRepo).toHaveBeenCalledWith('local-repo', true)
  expect(screen.queryByRole('status')).toBeNull()
})
it('fires once per peer/server-day and fires again for another day', async () => {
  const { store, api } = setup()
  await store.getState().refresh()
  expect(store.getState().collisions).toHaveLength(1)
  store.getState().dismissCollision('mine', 'peer')
  await store.getState().refresh()
  expect(store.getState().collisions).toHaveLength(0)
  vi.mocked(api.now).mockResolvedValue({
    ok: true,
    rows: [row('peer')],
    overflow: 0,
    server_time: '2026-09-14T00:00:01Z'
  })
  await store.getState().refresh()
  expect(store.getState().collisions).toHaveLength(1)
})
it('respects muted repos', async () => {
  const { store, api } = setup()
  vi.mocked(api.mutedRepos).mockResolvedValue(['local-repo'])
  await store.getState().refresh()
  expect(api.peers).not.toHaveBeenCalled()
  expect(store.getState().collisions).toHaveLength(0)
})
it('excludes only the exact local session; a second local pane and the same employee are peers', async () => {
  const { store, api } = setup()
  vi.mocked(api.now).mockResolvedValue(result([]))
  vi.mocked(api.localSessions).mockResolvedValue([local, { ...local, ledgerId: 'second' }])
  vi.mocked(api.peers).mockImplementation(async (ledgerId) => ({
    ok: true,
    peers: [
      { ledger_id: ledgerId, employee_id: 'me', reason: 'self' },
      { ledger_id: ledgerId === 'mine' ? 'second' : 'mine', employee_id: 'me', reason }
    ]
  }))
  await store.getState().refresh()
  expect(
    store
      .getState()
      .collisions.map((item) => item.peer.ledger_id)
      .sort()
  ).toEqual(['mine', 'second'])
  expect(store.getState().collisions.every((item) => item.peer.reason === reason)).toBe(true)
  expect(store.getState().seen.size).toBe(2)
})
it('names a peer absent from the bounded now page from the peer payload', async () => {
  const { store, api } = setup()
  vi.mocked(api.now).mockResolvedValue(result([]))
  vi.mocked(api.peers).mockResolvedValue({
    ok: true,
    peers: [{ ledger_id: 'peer', employee_name: 'Alice', reason: '   ' }]
  })
  await store.getState().refresh()
  render(<CollisionBanner store={store} />)
  expect(screen.getByText('Alice is working nearby')).toBeTruthy()
})
it('falls back to "a teammate" when the server sends no identity and no reason', async () => {
  const { store, api } = setup()
  vi.mocked(api.now).mockResolvedValue(result([]))
  vi.mocked(api.peers).mockResolvedValue({ ok: true, peers: [{ ledger_id: 'peer', reason: '' }] })
  await store.getState().refresh()
  render(<CollisionBanner store={store} />)
  expect(screen.getByText('a teammate is working nearby')).toBeTruthy()
})
it('drops a recorded collision once a refresh learns the repo is muted', async () => {
  const { store, api } = setup()
  await store.getState().refresh()
  expect(store.getState().collisions).toHaveLength(1)
  vi.mocked(api.mutedRepos).mockResolvedValue(['local-repo'])
  await store.getState().refresh()
  expect(store.getState().collisions).toHaveLength(0)
  render(<CollisionBanner store={store} />)
  expect(screen.queryByRole('status')).toBeNull()
})
it('falls back past an empty roster name and an empty payload name', async () => {
  const { store, api } = setup()
  vi.mocked(api.now).mockResolvedValue(result([row('peer', { employee_name: '' })]))
  vi.mocked(api.peers).mockResolvedValue({
    ok: true,
    peers: [{ ledger_id: 'peer', employee_id: '', employee_name: 'Alice', reason: '' }]
  })
  await store.getState().refresh()
  render(<CollisionBanner store={store} />)
  expect(screen.getByText('Alice is working nearby')).toBeTruthy()
  cleanup()
  store.getState().dismissCollision('mine', 'peer')
  vi.mocked(api.now).mockResolvedValue({
    ok: true,
    rows: [row('peer', { employee_name: '' })],
    overflow: 0,
    server_time: '2026-09-15T00:00:01Z'
  })
  vi.mocked(api.peers).mockResolvedValue({
    ok: true,
    peers: [{ ledger_id: 'peer', employee_id: ' ', employee_name: '', reason: ' ' }]
  })
  await store.getState().refresh()
  render(<CollisionBanner store={store} />)
  expect(screen.getByText('a teammate is working nearby')).toBeTruthy()
})
it('dismisses one local session notice and surfaces the other local record of the same peer', async () => {
  const { store, api } = setup()
  vi.mocked(api.localSessions).mockResolvedValue([local, { ...local, ledgerId: 'second' }])
  await store.getState().refresh()
  expect(store.getState().collisions.map((item) => item.local.ledgerId)).toEqual(['mine', 'second'])
  render(<CollisionBanner store={store} />)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss collision notice' }))
  expect(store.getState().collisions.map((item) => item.local.ledgerId)).toEqual(['second'])
  expect(screen.getByRole('status')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss collision notice' }))
  expect(store.getState().collisions).toHaveLength(0)
  expect(screen.queryByRole('status')).toBeNull()
})
it('keeps a server-returned peer even when it looks restricted', async () => {
  const { store, api } = setup()
  vi.mocked(api.now).mockResolvedValue(result([]))
  vi.mocked(api.peers).mockResolvedValue({
    ok: true,
    peers: [{ ledger_id: 'peer', employee_id: null, employee_name: null, reason, restricted: true }]
  } as never)
  await store.getState().refresh()
  expect(store.getState().collisions).toHaveLength(1)
})
it('checks collisions every 30s with only one timer while badge reads stay at 5min', async () => {
  vi.useFakeTimers()
  const { store, api } = setup()
  const stop = store.getState().start()
  await vi.advanceTimersByTimeAsync(0)
  vi.mocked(api.now).mockClear()
  vi.mocked(api.peers).mockClear()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(api.peers).toHaveBeenCalledExactlyOnceWith('mine')
  expect(api.now).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(270_000)
  expect(api.now).toHaveBeenCalledExactlyOnceWith('live')
  stop()
  expect(vi.getTimerCount()).toBe(0)
})
