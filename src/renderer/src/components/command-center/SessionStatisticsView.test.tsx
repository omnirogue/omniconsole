// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { sessionStatistics } from '@/lib/session-statistics'
import type { SessionSidebarTreeRow } from '@/lib/session-sidebar-group-model'
import type { SessionDataSnapshot, SessionDataStatus } from '@/lib/session-data-snapshot-store'
import { SessionStatisticsView } from './SessionStatisticsView'
import type { SessionStatisticsData } from './use-session-statistics-snapshot'
afterEach(cleanup)

function snapshot(
  status: SessionDataStatus = 'healthy'
): SessionDataSnapshot<SessionStatisticsData> {
  const rows = ['local', 'runtime:remote'].map((hostId) => ({
    session: { hostId, rowKey: hostId, sessionKey: hostId, unavailable: hostId !== 'local' },
    state: 'working',
    attention: null,
    waitingUntil: null
  })) as SessionSidebarTreeRow[]
  return {
    data: sessionStatistics(rows, Date.now()),
    status,
    issue:
      status === 'signed-out'
        ? 'signed-out'
        : status === 'stale' || status === 'unavailable'
          ? 'unavailable'
          : null,
    error: null,
    readAt: Date.now(),
    lastSuccessAt: status === 'stale' ? Date.now() : null
  }
}

it('shows host-qualified counts and retains unverifiable remote work', () => {
  render(
    <SessionStatisticsView
      snapshot={snapshot()}
      hostLabels={new Map([['runtime:remote', 'Fleet Mac']])}
    />
  )
  const local = screen.getByRole('rowheader', { name: 'This computer' }).closest('tr')!
  const remote = screen.getByRole('rowheader', { name: 'Fleet Mac' }).closest('tr')!
  expect(
    within(local)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
  ).toEqual(['0', '1', '0', '0', '0', '0', '0', '0', '1'])
  expect(
    within(remote)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
  ).toEqual(['0', '0', '0', '0', '0', '0', '0', '1', '1'])
})

it.each(['loading', 'signed-out', 'unavailable', 'stale'] as const)(
  'shows %s without hiding counts',
  (status) => {
    render(<SessionStatisticsView snapshot={snapshot(status)} embedded />)
    expect(screen.getByRole('status').textContent).not.toBe('')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    if (status === 'stale') {
      expect(screen.getByRole('status').textContent).toContain('last successful')
    }
  }
)

it('shows a healthy empty state explicitly', () => {
  const empty = { ...snapshot('healthy-empty'), data: sessionStatistics([], Date.now()) }
  render(<SessionStatisticsView snapshot={empty} embedded />)
  expect(screen.getByText('No sessions are listed.')).toBeTruthy()
})
