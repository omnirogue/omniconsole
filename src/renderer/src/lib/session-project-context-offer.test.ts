import { beforeEach, expect, it, vi } from 'vitest'
import { emptyProjectSettings } from '../../../shared/project-settings'
import type { SidebarSession } from './sidebar-sessions'

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
  send: vi.fn(async (_session: unknown, _text: string) => undefined),
  sessions: [] as unknown[],
  project: null as unknown
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./sidebar-sessions', () => ({ buildPaneSessions: () => mocks.sessions }))
vi.mock('./session-reply-send', () => ({
  canReplyToSession: (session: SidebarSession) => !session.unavailable,
  sendSessionReply: mocks.send
}))
vi.mock('./project-launch', () => ({
  launchProjectFor: (folderId: string) => (folderId === 'folder-1' ? mocks.project : null),
  projectLaunchHost: () => ({
    hostId: 'local',
    label: 'This computer',
    repoCheckout: () => null,
    skill: () => null
  })
}))

import {
  offerProjectContext,
  projectContextMessage,
  sendProjectContext
} from './session-project-context-offer'

function session(rowKey: string, overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey,
    sessionKey: null,
    worktreeId: 'wt-1',
    hostId: 'local',
    tabId: 'tab-1',
    paneKey: `tab-1:${rowKey}`,
    kind: 'terminal',
    label: rowKey,
    workspaceLabel: 'Shop',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sessions = [session('a'), session('b'), session('gone', { unavailable: true })]
  mocks.project = {
    folderId: 'folder-1',
    name: 'Checkout',
    settings: {
      ...emptyProjectSettings(0),
      attachments: [
        { id: 'instructions:1', kind: 'instructions', title: 'Rules', content: 'Ship small PRs.' }
      ]
    }
  }
})

it('builds the project line and context without an agent role', () => {
  const message = projectContextMessage('folder-1', 'wt-1')
  expect(message).toContain('Checkout')
  expect(message).toContain('Ship small PRs.')
  expect(projectContextMessage('other', 'wt-1')).toBeNull()
})

it('offers nothing outside a project or when no session can be reached', () => {
  offerProjectContext(['a'], 'other')
  offerProjectContext(['a'], null)
  offerProjectContext(['gone'], 'folder-1')
  expect(mocks.toast).not.toHaveBeenCalled()
})

it('only sends when the person accepts, once per reachable session', async () => {
  offerProjectContext(['a', 'b', 'gone'], 'folder-1')
  expect(mocks.toast).toHaveBeenCalledTimes(1)
  expect(mocks.send).not.toHaveBeenCalled()
  const { action } = mocks.toast.mock.calls[0]![1] as { action: { onClick: () => void } }
  action.onClick()
  await vi.waitFor(() => expect(mocks.toast.success).toHaveBeenCalled())
  expect(mocks.send.mock.calls.map(([target]) => (target as SidebarSession).rowKey)).toEqual([
    'a',
    'b'
  ])
})

it('reports each session that refused', async () => {
  mocks.send.mockRejectedValueOnce(new Error('The agent is not running.'))
  await expect(sendProjectContext(['a', 'b'], 'folder-1')).resolves.toEqual({
    sent: 1,
    failed: ['a: The agent is not running.']
  })
})
