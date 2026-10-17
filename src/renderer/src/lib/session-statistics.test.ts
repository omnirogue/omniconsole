import { expect, it } from 'vitest'
import { sessionStatistics } from './session-statistics'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

const now = new Date(2026, 9, 9, 12).getTime()
function row(
  key: string,
  patch: Partial<SessionSidebarTreeRow> = {},
  hostId = 'local'
): SessionSidebarTreeRow {
  return {
    session: {
      rowKey: `${hostId}:${key}`,
      sessionKey: key,
      hostId,
      worktreeId: 'folder:1',
      tabId: key,
      paneKey: `${key}:leaf`,
      kind: 'terminal',
      label: key,
      workspaceLabel: 'Folder workspace',
      agent: 'codex',
      unavailable: false,
      folderKeyMigration: null
    },
    folderId: null,
    attention: null,
    state: null,
    waitingUntil: null,
    ...patch
  } as SessionSidebarTreeRow
}

it('counts sidebar states and explicit completions, including children, once per execution host', () => {
  const working = row('same', { state: 'working' })
  const nested = row('nested', { state: 'idle' })
  const { total, byHost } = sessionStatistics(
    [
      working,
      working,
      row('same', { state: 'working', children: [nested] }, 'remote'),
      nested,
      row('question', { state: 'waiting' }),
      row('wait', { waitingUntil: '2026-10-10T00:00:00Z' }),
      row('done', { state: 'done', completed: { reason: 'done', at: now - 1000 } }),
      row('old', { state: 'done', completed: { reason: 'done', at: now - 86_400_000 } }),
      row('no-date', { state: 'done' }),
      row('stopped', { state: 'failed' }),
      row('unknown', {
        activityUnverifiable: true,
        state: 'done',
        completed: { reason: 'done', at: now }
      })
    ],
    now
  )
  expect(total).toEqual({
    total: 10,
    needsYou: 1,
    working: 2,
    waiting: 1,
    doneToday: 1,
    idle: 1,
    done: 3,
    stopped: 1,
    unverifiable: 1
  })
  expect(byHost.get('remote')?.working).toBe(1)
  expect(byHost.get('local')?.working).toBe(1)
})

it('uses local calendar boundaries, excludes future completions and preserves unavailable rows', () => {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const unavailable = row('away', { state: 'idle' })
  unavailable.session.unavailable = true
  const { total } = sessionStatistics(
    [
      row('today', { state: 'done', completed: { reason: 'finished', at: midnight.getTime() } }),
      row('yesterday', {
        state: 'done',
        completed: { reason: 'finished', at: midnight.getTime() - 1 }
      }),
      row('future', { state: 'done', completed: { reason: 'finished', at: now + 1 } }),
      row('empty'),
      unavailable
    ],
    now
  )
  expect(total.doneToday).toBe(1)
  expect(total.idle).toBe(1)
  expect(total.unverifiable).toBe(1)
  expect(sessionStatistics([], now).byHost.size).toBe(0)
})

it('keeps distinct rows without session keys and never assigns an unresolved host to local', () => {
  const first = row('unresolved-a', { state: 'working' })
  const second = row('unresolved-b', { state: 'idle' })
  for (const item of [first, second]) {
    item.session.sessionKey = null
    item.session.hostId = null
  }
  const result = sessionStatistics([first, second, first], now)
  expect(result.total.total).toBe(2)
  expect(result.byHost.has('local')).toBe(false)
  expect(result.byHost.get('unverifiable')).toMatchObject({ total: 2, working: 1, idle: 1 })
})
