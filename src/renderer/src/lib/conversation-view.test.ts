import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import { workingSessionTestSnapshot } from './sidebar-session-test-fixtures'
import { describe, expect, it } from 'vitest'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import {
  emptySessionSidebarView,
  setSessionGroupHidden,
  toggleSessionGroupCollapsed
} from './session-sidebar-view'
import { conversationViewKey, isPersonalRowHidden, isSessionRowDeleted } from './conversation-view'
import type { SidebarSession } from './sidebar-sessions'

const row = (id: string): SidebarSession => ({
  rowKey: id,
  sessionKey: id,
  worktreeId: 'w',
  paneKey: `pane-${id}`,
  tabId: `tab-${id}`,
  hostId: 'local',
  kind: 'terminal',
  label: id,
  agent: 'codex',
  workspaceLabel: 'Work',
  unavailable: false,
  folderKeyMigration: null
})
const a = row('a'),
  b = row('b')
// Why: a hide mark takes a row to Hidden only once its tab is closed (Sal, 2026-09-23).
const closed = (session: SidebarSession): SidebarSession => ({ ...session, tabId: null })
const folder = '00000000-0000-4000-8000-000000000001'
const base = {
  sessions: [a, b],
  metadata: {
    version: 1 as const,
    folders: [{ id: folder, name: 'Planning' }],
    membership: { a: folder, b: folder }
  },
  view: emptySessionSidebarView(),
  query: '',
  showHidden: false,
  snapshot: workingSessionTestSnapshot([a, b])
}

describe('personal conversation projection', () => {
  it('hides without changing session or folder state and restores prior custom order', () => {
    const view = { ...base.view, rowOrder: ['b', 'a'] }
    const hidden = setSessionGroupHidden(view, 'conversation:b', true)
    const tree = buildSessionSidebarTree({ ...base, sessions: [a, closed(b)], view: hidden })
    expect(
      tree.groups.find((group) => group.kind === 'folder')?.rows.map((r) => r.session.sessionKey)
    ).toEqual(['a'])
    const hiddenGroup = tree.groups.find((group) => group.kind === 'hidden')!
    expect(hiddenGroup.rows.map((r) => r.session.sessionKey)).toEqual(['b'])
    expect(hiddenGroup.collapsed).toBe(true)
    expect(
      buildSessionSidebarTree({
        ...base,
        sessions: [a, closed(b)],
        view: toggleSessionGroupCollapsed(hidden, hiddenGroup.key)
      }).groups.at(-1)?.collapsed
    ).toBe(false)
    const restored = buildSessionSidebarTree({
      ...base,
      view: setSessionGroupHidden(hidden, 'conversation:b', false)
    })
    expect(
      restored.groups
        .find((group) => group.kind === 'folder')
        ?.rows.map((r) => r.session.sessionKey)
    ).toEqual(['b', 'a'])
    expect(base.metadata.membership).toEqual({ a: folder, b: folder })
    expect(b.unavailable).toBe(false)
  })
  it('separates manual hiding from waits, and expiry does not unhide a manual choice', () => {
    const view = setSessionGroupHidden(base.view, 'conversation:a', true)
    const tree = buildSessionSidebarTree({
      ...base,
      sessions: [closed(a), b],
      view,
      snapshot: EMPTY_AGENT_PANE_SNAPSHOT,
      waitingUntilByPaneKey: new Map([['pane-b', '2099-01-01T00:00:00Z']])
    })
    expect(tree.groups.filter((group) => group.rows.length).map((group) => group.kind)).toEqual([
      'folder',
      'hidden'
    ])
    expect(tree.groups.find((group) => group.kind === 'folder')?.rows[0]).toMatchObject({
      session: { sessionKey: 'b' },
      pursuitState: 'waiting'
    })
    const expired = buildSessionSidebarTree({
      ...base,
      sessions: [closed(a), b],
      view,
      snapshot: EMPTY_AGENT_PANE_SNAPSHOT,
      waitingUntilByPaneKey: new Map()
    })
    expect(
      expired.groups.find((group) => group.kind === 'folder')?.rows[0].session.sessionKey
    ).toBe('b')
    expect(expired.groups.at(-1)?.rows[0].session.sessionKey).toBe('a')
  })
  // Why: since #135 Sessions and Conversations share one organizer, so hiding a row in either
  // view hides it in both; other lists keep their own hidden marks.
  it('shares hiding between Sessions and Conversations', () => {
    const view = setSessionGroupHidden(base.view, 'session:a', true)
    expect(isPersonalRowHidden(view, a, 'session')).toBe(true)
    expect(isPersonalRowHidden(view, a)).toBe(true)
    expect(isPersonalRowHidden(view, a, 'company')).toBe(false)
    expect(
      isPersonalRowHidden(setSessionGroupHidden(base.view, 'conversation:a', true), a, 'session')
    ).toBe(true)
    expect(conversationViewKey(a)).toBe('a')
  })
  // Why one predicate: the tree, management rows and the conversation ledger drop the same rows.
  it('drops a deleted conversation until its tab is open again', () => {
    const deleted = new Set(['a'])
    expect(isSessionRowDeleted(deleted, closed(a))).toBe(true)
    expect(isSessionRowDeleted(deleted, a)).toBe(false)
    expect(isSessionRowDeleted(deleted, closed(b))).toBe(false)
    expect(
      buildSessionSidebarTree({
        ...base,
        sessions: [closed(a), b],
        view: { ...base.view, deleted: ['a'] }
      }).totalRows
    ).toBe(1)
  })
})
