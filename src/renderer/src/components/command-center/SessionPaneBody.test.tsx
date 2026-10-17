// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { structuredSessionFolderKey } from '@/lib/session-folder-identity'
import { PaneFocusContext } from '../pane-focus-context'
const mocks = vi.hoisted(() => ({
  enabled: true,
  windowVisible: true,
  onVisibility: () => {},
  chat: vi.fn()
}))
const tab = {
  id: 'tab',
  worktreeId: 'folder',
  entityId: 'chat',
  contentType: 'agent-session',
  executionHostId: 'runtime:owner'
}
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: { commandCenter: mocks.enabled },
      unifiedTabsByWorktree: { folder: [tab] }
    })
}))
vi.mock('@/lib/sidebar-session-context', () => ({
  sidebarSessionWorkspace: (_state: unknown, _workspace: string, hostId: string) => ({ hostId })
}))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => mocks.windowVisible,
  subscribeWindowParkVisibility: (listener: () => void) => {
    mocks.onVisibility = listener
    return () => {}
  }
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./BorrowedSessionPaneBody', () => ({
  BorrowedSessionPaneBody: () => <div>Borrowed main session view</div>
}))
vi.mock('../native-chat/NativeChatViewSwitch', () => ({
  NativeChatViewSwitch: () => <div>Shared session view switch</div>
}))
vi.mock('../native-chat/NativeChatStructuredSession', () => ({
  NativeChatStructuredSession: (props: unknown) => {
    mocks.chat(props)
    return <div>Existing chat history</div>
  }
}))
vi.mock('./SessionPaneIsland', () => ({ SessionPaneIsland: () => <div>Session island</div> }))
import { SessionPaneBody } from './SessionPaneBody'
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: structuredSessionFolderKey('runtime:owner', 'chat'),
  worktreeId: 'folder',
  hostId: 'runtime:owner',
  tabId: 'tab',
  paneKey: null,
  kind: 'structured',
  structuredSessionId: 'chat',
  agent: 'codex',
  label: 'chat',
  workspaceLabel: 'folder',
  unavailable: false,
  folderKeyMigration: null
}
const visibleFocus = { visible: true, focused: false }
const hiddenFocus = { visible: false, focused: false }
beforeEach(() => {
  mocks.enabled = true
  mocks.windowVisible = true
  mocks.chat.mockClear()
})
afterEach(cleanup)
describe('session pane body', () => {
  it('routes terminal-backed agents to the borrowed main view', () => {
    render(<SessionPaneBody session={{ ...session, kind: 'terminal' }} onOpen={vi.fn()} />)
    expect(screen.getByText('Borrowed main session view')).toBeTruthy()
    expect(mocks.chat).not.toHaveBeenCalled()
  })
  it('passes host-qualified identity and real pane/window visibility to passive chat', () => {
    const body = (visible: boolean) => (
      <PaneFocusContext.Provider value={visible ? visibleFocus : hiddenFocus}>
        <SessionPaneBody session={session} onOpen={vi.fn()} />
      </PaneFocusContext.Provider>
    )
    const view = render(body(true))
    expect(screen.getByText('Existing chat history')).toBeTruthy()
    expect(screen.getByText('Shared session view switch')).toBeTruthy()
    expect(mocks.chat.mock.calls.at(-1)?.[0]).toMatchObject({
      viewer: true,
      isVisible: true,
      worktreeId: 'folder',
      sessionId: 'chat',
      tabId: 'tab',
      target: { kind: 'environment', environmentId: 'owner' }
    })
    view.rerender(body(false))
    expect(mocks.chat.mock.calls.at(-1)?.[0].isVisible).toBe(false)
    view.rerender(body(true))
    act(() => {
      mocks.windowVisible = false
      mocks.onVisibility()
    })
    expect(mocks.chat.mock.calls.at(-1)?.[0].isVisible).toBe(false)
    act(() => {
      mocks.windowVisible = true
      mocks.onVisibility()
    })
    expect(mocks.chat.mock.calls.at(-1)?.[0].isVisible).toBe(true)
  })
  it('renders a missing-id error without mounting a chat', () => {
    render(
      <SessionPaneBody session={{ ...session, structuredSessionId: undefined }} onOpen={vi.fn()} />
    )
    expect(screen.getByText('This chat row is missing its session identity.')).toBeTruthy()
    expect(mocks.chat).not.toHaveBeenCalled()
  })
  it('explains a remote-only session without opening a local chat', () => {
    render(
      <SessionPaneBody session={{ ...session, tabId: null, unavailable: true }} onOpen={vi.fn()} />
    )
    expect(screen.getByText('Open on that computer')).toBeTruthy()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(screen.queryByText(/exited|Move here/i)).toBeNull()
  })
  it('does nothing with commandCenter off', () => {
    mocks.enabled = false
    const view = render(<SessionPaneBody session={session} onOpen={vi.fn()} />)
    expect(view.container.innerHTML).toBe('')
    expect(mocks.chat).not.toHaveBeenCalled()
  })
})
