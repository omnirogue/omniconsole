vi.mock('./EmployeePeopleList', () => ({ EmployeePeopleList: () => <div>Employee directory</div> }))
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
vi.mock('@/lib/session-ledger-console', () => ({ openSessionLedgerConsole: vi.fn() }))
vi.mock('@/lib/session-ledger-api', () => ({ getSessionLedgerApi: vi.fn() }))
import { getSessionLedgerApi } from '@/lib/session-ledger-api'
import { openSessionLedgerConsole } from '@/lib/session-ledger-console'
import { createSessionLedgerStore } from '@/store/session-ledger-store'
import type { LedgerNowResult, SessionLedgerApi } from '@/lib/session-ledger-types'
import { ledgerPublicRowSchema } from '../../../../../shared/session-ledger-contract'
import {
  ledgerApi,
  memoryStorage,
  restrictedRow,
  result,
  row
} from './session-ledger-test-fixtures'
import TeamSessionsSidebar from './TeamSessionsSidebar'
const stops: (() => void)[] = []
afterEach(() => {
  cleanup()
  stops.splice(0).forEach((stop) => stop())
  vi.useRealTimers()
  vi.clearAllMocks()
})
function mount(api?: SessionLedgerApi) {
  vi.mocked(getSessionLedgerApi).mockReturnValue(api)
  const store = createSessionLedgerStore(memoryStorage(), getSessionLedgerApi, async () => 'me')
  stops.push(store.getState().start())
  const view = render(
    <TooltipProvider>
      <TeamSessionsSidebar store={store} />
    </TooltipProvider>
  )
  return { store, ...view }
}
it('groups and sorts live and server-today rows, trusts the server day cut, and shows overflow', async () => {
  const rows = [
    row('older', { last_activity_at: '2026-09-13T10:00:00Z' }),
    row('newer'),
    row('finished', { state: 'done' }),
    row('abandoned', { state: 'abandoned', last_activity_at: '2026-09-13T11:00:00Z' }),
    // Why: the server cuts "today" in the caller's zone; a row it returns just before the
    // UTC midnight is still today's and must not be re-filtered by the Z-suffixed clock.
    row('late-local', { state: 'done', last_activity_at: '2026-09-12T23:30:00Z' })
  ]
  const yesterday = row('yesterday', { state: 'done', last_activity_at: '2026-09-12T12:00:00Z' })
  mount(
    ledgerApi({
      now: vi.fn(async (scope) =>
        scope === 'live' ? result([...rows, yesterday], 3) : result(rows, 0)
      )
    })
  )
  await screen.findByText('newer')
  expect(
    within(screen.getByRole('region', { name: 'Live now' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent)
  ).toEqual([expect.stringContaining('newer'), expect.stringContaining('older')])
  expect(
    within(screen.getByRole('region', { name: 'Today' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent)
  ).toEqual([
    expect.stringContaining('finished'),
    expect.stringContaining('abandoned'),
    expect.stringContaining('late-local')
  ])
  expect(screen.queryByText('yesterday')).toBeNull()
  expect(screen.getByText('+3 more in the console')).toBeTruthy()
})
it('decodes and lists a restricted row as an existence-only entry without dropping the response', async () => {
  const restricted = restrictedRow('hidden')
  expect(ledgerPublicRowSchema.safeParse(restricted).success).toBe(true)
  mount(ledgerApi({ now: vi.fn(async () => result([row('open'), restricted], 0)) }))
  await screen.findByText('open')
  const items = within(screen.getByRole('region', { name: 'Live now' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
  expect(items).toHaveLength(2)
  const entry = items.find((text) => text.includes('hidden person'))
  expect(entry).toBeDefined()
  // Nothing beyond who and which agent: no repo, branch, card or last action leaks through.
  expect(entry).not.toMatch(/repo|branch|card|#/)
})

it('shows loading skeletons while reads are pending', () => {
  mount(ledgerApi({ now: vi.fn(() => new Promise<LedgerNowResult>(() => {})) }))
  expect(screen.getAllByRole('status', { name: 'Loading team sessions' })).toHaveLength(2)
})
it('shows sign-in copy without retry', async () => {
  mount(ledgerApi({ now: vi.fn().mockResolvedValue({ ok: false, reason: 'signed-out' }) }))
  await waitFor(() => expect(screen.getAllByText('Sign in to see your team')).toHaveLength(2))
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})
it.each(['offline', 'unavailable'] as const)('shows %s inline and retries', async (reason) => {
  const api = ledgerApi({ now: vi.fn().mockResolvedValue({ ok: false, reason }) })
  mount(api)
  await screen.findAllByText('Team sessions unavailable')
  vi.mocked(api.now).mockResolvedValue(result([row('recovered')]))
  fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
  expect(await screen.findByText('recovered')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('treats missing preload as unavailable', async () => {
  mount()
  expect(await screen.findAllByText('Team sessions unavailable')).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2)
})
it('opens history through the console helper and excludes self from the badge', async () => {
  const { store } = mount(
    ledgerApi({ now: vi.fn().mockResolvedValue(result([row('me'), row('peer')])) })
  )
  await screen.findByText('peer')
  expect(store.getState().badgeCount).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'See history' }))
  expect(openSessionLedgerConsole).toHaveBeenCalledWith()
})
it('polls every 30s while mounted and clears that cadence on unmount', async () => {
  vi.useFakeTimers()
  const api = ledgerApi()
  const { unmount } = mount(api)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  vi.mocked(api.now).mockClear()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(api.now).toHaveBeenCalledTimes(2)
  unmount()
  vi.mocked(api.now).mockClear()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(api.now).not.toHaveBeenCalled()
  stops.splice(0).forEach((stop) => stop())
  expect(vi.getTimerCount()).toBe(0)
})
it('shows global overflow once outside the sections while Today has only live rows', async () => {
  mount(ledgerApi({ now: vi.fn(async () => result([row('working')], 7)) }))
  await screen.findByText('working')
  expect(screen.getAllByText('+7 more in the console')).toHaveLength(1)
  expect(screen.getByText('+7 more in the console').closest('section')).toBeNull()
  expect(
    within(screen.getByRole('region', { name: 'Today' })).getByText(
      'No finished sessions yet today'
    )
  ).toBeTruthy()
})
it('hides global overflow when neither section has visible rows', async () => {
  mount(ledgerApi({ now: vi.fn(async () => result([], 7)) }))
  await screen.findByText('No sessions')
  expect(screen.queryByText('+7 more in the console')).toBeNull()
})
it('uses today overflow if the live answer is unavailable', async () => {
  mount(
    ledgerApi({
      now: vi.fn(async (scope) =>
        scope === 'live'
          ? { ok: false as const, reason: 'unavailable' as const }
          : result([row('finished', { state: 'done' })], 4)
      )
    })
  )
  expect(await screen.findByText('+4 more in the console')).toBeTruthy()
})
