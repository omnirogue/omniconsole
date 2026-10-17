// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'

const scheduleWhenFinished = vi.hoisted(() => vi.fn())
const LEAF = '0f8fad5b-d9cb-469f-a165-70867728950e'
const cleanupSession = vi.hoisted(
  () =>
    ({
      rowKey: 'row-cleanup',
      sessionKey: 'cleanup',
      worktreeId: 'cleanup-repo::/cleanup',
      hostId: 'local',
      tabId: 'tab-cleanup',
      paneKey: 'tab-cleanup:0f8fad5b-d9cb-469f-a165-70867728950e',
      kind: 'terminal',
      label: 'Session cleanup run 4 · automatic',
      workspaceLabel: 'Session cleanup',
      agent: 'claude',
      unavailable: false,
      folderKeyMigration: null
    }) as SidebarSession
)

vi.mock('@/lib/session-when-finished', () => ({ scheduleWhenFinished }))
vi.mock('@/lib/sidebar-sessions', () => ({ buildPaneSessions: () => [cleanupSession] }))
vi.mock('@/lib/session-manage-sidebar-rows', () => ({
  buildSessionManageSidebarRows: vi.fn(),
  matchManagedSession: (
    sessions: SidebarSession[],
    target: { paneKey?: string; tabId?: string }
  ): SidebarSession | null => sessions.find((session) => session.paneKey === target.paneKey) ?? null
}))

const { answerSessionManageRequest } = await import('./session-manage-requests')

beforeEach(() => {
  scheduleWhenFinished.mockReset()
})

describe('scheduleFinish from main', () => {
  it('sets the finished cleanup session to End, the same choice a person can make', () => {
    const reply = answerSessionManageRequest({
      kind: 'scheduleFinish',
      paneKey: `tab-cleanup:${LEAF}`,
      tabId: 'tab-cleanup',
      action: 'end'
    })

    expect(reply).toEqual({ scheduled: true })
    expect(scheduleWhenFinished).toHaveBeenCalledWith(cleanupSession, { action: 'end' })
  })

  it('refuses a pane the sidebar does not have, changing nothing', () => {
    expect(() =>
      answerSessionManageRequest({ kind: 'scheduleFinish', paneKey: 'tab-x:gone', action: 'end' })
    ).toThrow('No conversation in the sidebar matches pane tab-x:gone.')
    expect(scheduleWhenFinished).not.toHaveBeenCalled()
  })
})
