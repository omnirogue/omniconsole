import { sidebarSessionStatusKey } from './sidebar-session-source-identity'
import { countByState, type SessionActivity } from '@/components/work/work-model'
import { waitLaterKeyForPane } from './wait-later'

export function sessionOverviewCounts(
  rows: readonly SessionActivity[],
  finished: ReadonlyMap<string, number>,
  now: number
): Record<'needs-you' | 'working' | 'waiting' | 'doneToday' | 'idle', number> {
  const { finished: _finished, ...counts } = countByState(rows)
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return {
    ...counts,
    doneToday: rows.filter((row) => {
      const sourceKey = sidebarSessionStatusKey(row.session)
      const marked = sourceKey ? finished.get(waitLaterKeyForPane(sourceKey)) : undefined
      const at = marked ?? row.card?.stateChangedAt
      return (
        row.state === 'finished' &&
        at !== undefined &&
        at >= start.getTime() &&
        at < end.getTime() &&
        at <= now
      )
    }).length
  }
}

export function selectSessionOverviewCounts(
  rows: readonly SessionActivity[],
  finished: ReadonlyMap<string, number>
): { counts: ReturnType<typeof sessionOverviewCounts>; now: number } {
  const now = Date.now()
  return { counts: sessionOverviewCounts(rows, finished, now), now }
}
