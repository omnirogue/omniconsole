import { describe, expect, it } from 'vitest'
import {
  parseSessionGridSnapshot,
  resolveSessionGridSession,
  sameSessionGridContent,
  type SessionGridPaneContent
} from './session-grid-panes'
import type { SidebarSession } from './sidebar-sessions'

const sessionContent = (
  patch: Partial<Extract<SessionGridPaneContent, { kind: 'session' }>> = {}
): Extract<SessionGridPaneContent, { kind: 'session' }> => ({
  kind: 'session',
  worktreeId: 'wt',
  tabId: 'tab-1',
  paneKey: 'pane-1',
  sessionKey: 'key-1',
  executionHostId: 'local',
  label: 'Ads',
  ...patch
})

const sidebarSession = (patch: Partial<SidebarSession>): SidebarSession =>
  ({
    rowKey: 'row',
    hostId: 'local',
    sessionKey: null,
    worktreeId: 'wt',
    tabId: null,
    paneKey: null,
    unavailable: false,
    ...patch
  }) as SidebarSession

describe('session grid panes', () => {
  it('knows the same conversation by its key, its pane or its terminal tab', () => {
    const base = sessionContent()
    expect(sameSessionGridContent(base, sessionContent({ tabId: 'x', paneKey: 'y' }))).toBe(true)
    expect(sameSessionGridContent(base, sessionContent({ sessionKey: 'k2', tabId: 'x' }))).toBe(
      true
    )
    expect(sameSessionGridContent(base, sessionContent({ sessionKey: 'k2', paneKey: 'p2' }))).toBe(
      true
    )
    expect(
      sameSessionGridContent(base, sessionContent({ sessionKey: 'k2', paneKey: 'p2', tabId: 't2' }))
    ).toBe(false)
    expect(
      sameSessionGridContent(
        { kind: 'browser', worktreeId: 'wt', browserTabId: 'b1', label: '' },
        { kind: 'browser', worktreeId: 'wt2', browserTabId: 'b1', label: 'x' }
      )
    ).toBe(true)
  })

  it('finds a resumed conversation by its key once its old tab is gone', () => {
    const resumed = sidebarSession({ sessionKey: 'key-1', tabId: 'tab-9', paneKey: 'pane-9' })
    expect(resolveSessionGridSession(sessionContent(), [resumed])).toBe(resumed)
  })

  it('prefers the exact pane over another conversation in the same tab', () => {
    const first = sidebarSession({ sessionKey: 'a', tabId: 'tab-1', paneKey: 'pane-0' })
    const mine = sidebarSession({ sessionKey: 'b', tabId: 'tab-1', paneKey: 'pane-1' })
    expect(resolveSessionGridSession(sessionContent(), [first, mine])).toBe(mine)
  })

  it('drops whatever a damaged save holds instead of throwing', () => {
    const parsed = parseSessionGridSnapshot({
      panes: {
        good: { kind: 'notepad', noteId: 'n1' },
        bad: { kind: 'session' },
        other: 'nope'
      },
      layout: { orientation: 'sideways', tracks: [['good', 'bad', 'good']], trackSizes: ['x'] },
      minimized: ['good', 'ghost', 7],
      focusedPaneId: 'bad',
      notes: { n1: { title: 3, text: 'hello' } }
    })
    expect(Object.keys(parsed.panes)).toEqual(['good'])
    expect(parsed.layout.tracks).toEqual([['good']])
    expect(parsed.layout.orientation).toBe('columns')
    expect(parsed.minimized).toEqual([])
    expect(parsed.focusedPaneId).toBeNull()
    expect(parsed.notes).toEqual({ n1: { title: '', text: 'hello' } })
    expect(parseSessionGridSnapshot(null).panes).toEqual({})
  })
})

describe('host-qualified grid panes', () => {
  it('never matches a remote row to a local pane with the same pane and tab ids', () => {
    const local = sidebarSession({ sessionKey: 'local-key', tabId: 'tab-1', paneKey: 'pane-1' })
    const remote = sidebarSession({
      hostId: 'runtime:other',
      sessionKey: 'remote-key',
      tabId: 'tab-1',
      paneKey: 'pane-1'
    })
    const content = sessionContent({ executionHostId: 'runtime:other', sessionKey: 'remote-key' })
    expect(resolveSessionGridSession(content, [local, remote])).toBe(remote)
    expect(resolveSessionGridSession(content, [local])).toBeNull()
    expect(sameSessionGridContent(content, sessionContent({ sessionKey: 'local-key' }))).toBe(false)
  })

  it('uses only the qualified session key for legacy panes without a saved host', () => {
    const local = sidebarSession({ sessionKey: 'local-key', tabId: 'tab-1', paneKey: 'pane-1' })
    expect(
      resolveSessionGridSession(sessionContent({ executionHostId: undefined }), [local])
    ).toBeNull()
    const exact = sidebarSession({ sessionKey: 'key-1' })
    expect(
      resolveSessionGridSession(sessionContent({ executionHostId: undefined }), [local, exact])
    ).toBe(exact)
  })
})
