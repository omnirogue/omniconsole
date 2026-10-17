// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  getSessionPaneChatController,
  publishSessionPaneChatController,
  removeSessionPaneChatController,
  sessionPaneChatKey
} from '@/lib/session-pane-chat-controller'
import { structuredSessionFolderKey } from '@/lib/session-folder-identity'
import { PaneFocusContext } from '../pane-focus-context'
const mocks = vi.hoisted(() => ({ enabled: true, send: vi.fn(), windowVisible: true }))
const tab = {
  id: 'structured-agent-session-chat',
  entityId: 'chat',
  contentType: 'agent-session',
  worktreeId: 'wt',
  agentSessionAgent: 'codex',
  executionHostId: 'local'
}
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ settings: { commandCenter: mocks.enabled }, unifiedTabsByWorktree: { wt: [tab] } })
}))
vi.mock('@/lib/sidebar-session-context', () => ({
  sidebarSessionWorkspace: () => ({ hostId: 'local' })
}))
vi.mock('../session-activity/use-session-activity', () => ({
  useSessionActivityStatus: () => ({ state: 'waiting', lastAssistantMessage: 'Which option?' }),
  useSessionActivity: () => ({ line: 'Waiting for you' })
}))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => mocks.windowVisible,
  subscribeWindowParkVisibility: () => () => {}
}))
vi.mock('@/lib/session-reply-send', () => ({
  canReplyToSession: () => true,
  sendSessionReply: mocks.send
}))
vi.mock('../AgentStateDot', () => ({ AgentStateDot: () => <span>State dot</span> }))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => <span>Provider</span> }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { SessionPaneIsland } from './SessionPaneIsland'
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: structuredSessionFolderKey('local', 'chat'),
  hostId: 'local',
  worktreeId: 'wt',
  tabId: tab.id,
  paneKey: null,
  kind: 'structured',
  structuredSessionId: 'chat',
  label: 'Chat',
  agent: 'codex',
  workspaceLabel: 'Workspace',
  unavailable: false,
  folderKeyMigration: null
}
const key = sessionPaneChatKey('local', 'wt', tab.id)
const owner = Symbol('test')
const hiddenFocus = { visible: false, focused: false }
beforeEach(() => {
  mocks.enabled = true
  mocks.windowVisible = true
  mocks.send.mockReset()
})
afterEach(() => {
  cleanup()
  removeSessionPaneChatController(key, owner)
})
describe('session pane island', () => {
  it('starts collapsed and expands without starting or sending to a session', () => {
    render(<SessionPaneIsland session={session} onOpen={vi.fn()} />)
    expect(screen.queryByLabelText('Quick reply')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Session status' }).getAttribute('aria-expanded')
    ).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Session status' }))
    expect(screen.getByText('Which option?')).toBeTruthy()
    expect((screen.getByLabelText('Quick reply') as HTMLInputElement).disabled).toBe(true)
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('blocks a paused viewer and uses only the resumed viewer controller for replies', () => {
    const send = vi.fn(() => true)
    publishSessionPaneChatController(key, owner, {
      writable: false,
      needsYou: 0,
      messages: [],
      send
    })
    render(<SessionPaneIsland session={session} onOpen={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Session status' }))
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(send).not.toHaveBeenCalled()
    act(() => {
      publishSessionPaneChatController(key, owner, {
        writable: true,
        needsYou: 1,
        messages: [],
        send
      })
    })
    fireEvent.change(screen.getByLabelText('Quick reply'), { target: { value: 'Continue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith('Continue')
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('blocks a hidden pane even with a live controller and opens the full view explicitly', () => {
    publishSessionPaneChatController(key, owner, {
      writable: true,
      needsYou: 0,
      messages: [],
      send: vi.fn(() => true)
    })
    const open = vi.fn()
    render(
      <PaneFocusContext.Provider value={hiddenFocus}>
        <SessionPaneIsland session={session} onOpen={open} />
      </PaneFocusContext.Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session status' }))
    expect((screen.getByLabelText('Quick reply') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open full view' }))
    expect(open).toHaveBeenCalledWith(session)
  })
  it('removes only its publisher and isolates execution hosts', () => {
    const secondOwner = Symbol('other')
    const value = { writable: true, needsYou: 0, messages: [], send: vi.fn(() => true) }
    publishSessionPaneChatController(key, owner, value)
    publishSessionPaneChatController(key, secondOwner, value)
    removeSessionPaneChatController(key, owner)
    expect(getSessionPaneChatController(key)).toBe(value)
    expect(
      getSessionPaneChatController(sessionPaneChatKey('runtime:peer', 'wt', tab.id))
    ).toBeNull()
    removeSessionPaneChatController(key, secondOwner)
  })
  it('renders nothing with the setting off', () => {
    mocks.enabled = false
    expect(
      render(<SessionPaneIsland session={session} onOpen={vi.fn()} />).container.innerHTML
    ).toBe('')
  })
})
