import { describe, expect, it } from 'vitest'
import type { SessionProjectThread } from './session-project-threads'
import {
  countSessionProjectThreadGroups,
  groupSessionProjectThreads,
  searchSessionProjectThreads,
  sessionProjectStatusesWithoutAGroup,
  sortSessionProjectThreads
} from './session-project-thread-groups'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'

function thread(
  key: string,
  status: SessionProjectThread['status'],
  over: Partial<Omit<SessionProjectThread, 'row' | 'status'>> & {
    label?: string
    workspaceLabel?: string
  } = {}
): SessionProjectThread {
  const { label, workspaceLabel, ...rest } = over
  const row = {
    session: {
      rowKey: key,
      sessionKey: key,
      worktreeId: 'folder:1',
      hostId: 'local',
      tabId: key,
      paneKey: `${key}:leaf-1`,
      kind: 'terminal',
      label: label ?? key,
      workspaceLabel: workspaceLabel ?? 'Website / main',
      agent: 'codex',
      unavailable: false,
      folderKeyMigration: null
    },
    folderId: 'project',
    attention: null,
    state: null,
    waitingUntil: null
  } as SessionSidebarTreeRow
  return {
    row,
    status,
    isCoordinator: false,
    agent: 'codex',
    lastActivityAt: null,
    ...rest
  }
}

describe('groupSessionProjectThreads', () => {
  it('orders groups needs-you first, keeps an empty Needs you, and files stateless rows as idle', () => {
    const groups = groupSessionProjectThreads([
      thread('a', 'done'),
      thread('b', null),
      thread('c', 'working'),
      thread('d', 'reviewReady'),
      thread('e', 'working'),
      thread('f', 'cantSee')
    ])
    expect(groups.map((group) => [group.key, group.threads.length])).toEqual([
      ['needsYou', 0],
      ['reviewReady', 1],
      ['working', 2],
      ['done', 1],
      ['cantSee', 1],
      ['idle', 1]
    ])
    expect(groups[2]!.threads.map((t) => t.row.session.rowKey)).toEqual(['c', 'e'])
  })

  it('gives every shared status a group', () => {
    expect(sessionProjectStatusesWithoutAGroup()).toEqual([])
  })

  it('counts every group, empty ones included', () => {
    expect(countSessionProjectThreadGroups([thread('a', 'needsYou'), thread('b', null)])).toEqual({
      needsYou: 1,
      reviewReady: 0,
      working: 0,
      waiting: 0,
      done: 0,
      stopped: 0,
      cantSee: 0,
      idle: 1
    })
  })
})

describe('sortSessionProjectThreads', () => {
  it('pins the coordinator, then newest activity, then rows without a report in their order', () => {
    const sorted = sortSessionProjectThreads([
      thread('quiet-1', null),
      thread('old', 'done', { lastActivityAt: 10 }),
      thread('quiet-2', null),
      thread('chat', 'working', { isCoordinator: true, lastActivityAt: 1 }),
      thread('new', 'working', { lastActivityAt: 20 })
    ])
    expect(sorted.map((t) => t.row.session.rowKey)).toEqual([
      'chat',
      'new',
      'old',
      'quiet-1',
      'quiet-2'
    ])
  })
})

describe('searchSessionProjectThreads', () => {
  const threads = [
    thread('a', 'working', { label: 'Fix checkout totals' }),
    thread('b', 'done', { label: 'Write release notes', model: 'claude-opus' }),
    thread('c', 'done', { workspaceLabel: 'Mobile / main' })
  ]

  it('matches title, workspace, agent and model without case, and keeps everything for a blank query', () => {
    expect(searchSessionProjectThreads(threads, '  ')).toHaveLength(3)
    expect(
      searchSessionProjectThreads(threads, 'CHECKOUT').map((t) => t.row.session.rowKey)
    ).toEqual(['a'])
    expect(searchSessionProjectThreads(threads, 'opus').map((t) => t.row.session.rowKey)).toEqual([
      'b'
    ])
    expect(searchSessionProjectThreads(threads, 'mobile').map((t) => t.row.session.rowKey)).toEqual(
      ['c']
    )
    expect(searchSessionProjectThreads(threads, 'codex')).toHaveLength(3)
  })
})
