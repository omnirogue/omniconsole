// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { AppState } from '@/store/types'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import { PaneFocusContext } from '../pane-focus-context'
import { NativeChatViewSwitch } from '../native-chat/NativeChatViewSwitch'
import { BorrowedSessionPaneBody } from './BorrowedSessionPaneBody'
import { TooltipProvider } from '../ui/tooltip'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { paneSessionFolderKey } from '@/lib/session-folder-identity'

const mocks = vi.hoisted(() => {
  return {
    store: null as unknown as UseBoundStore<StoreApi<AppState>>,
    publish: vi.fn<(targets: ActivityTerminalPortalTarget[], owner: string) => void>(),
    mount: vi.fn(),
    focus: vi.fn()
  }
})
vi.mock('@/store', () => {
  const useAppStore = <T,>(selector: (state: AppState) => T) => mocks.store(selector)
  useAppStore.getState = () => mocks.store.getState()
  return { useAppStore }
})
vi.mock('@/lib/sidebar-session-context', () => ({
  sidebarSessionWorkspace: (_state: unknown, _workspace: string, hostId: string) => ({ hostId })
}))
vi.mock('../activity/activity-terminal-portal', () => ({
  setActivityTerminalPortals: mocks.publish
}))
vi.mock('../terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mocks.mount
}))
vi.mock('../native-chat/native-chat-view-focus', () => ({ focusNativeChatView: mocks.focus }))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatToggled: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
mocks.store = create<AppState>(() => ({}) as AppState)
const leafId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const paneKey = `terminal:${leafId}`
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: paneSessionFolderKey('local', 'folder', paneKey),
  worktreeId: 'folder',
  hostId: 'local',
  tabId: 'terminal',
  paneKey,
  kind: 'terminal',
  agent: 'claude',
  label: 'Claude',
  workspaceLabel: 'folder',
  unavailable: false,
  folderKeyMigration: null
}
const shown = { visible: true, focused: true }
const hidden = { visible: false, focused: true }
function body(visible = true) {
  return (
    <TooltipProvider>
      <PaneFocusContext.Provider value={visible ? shown : hidden}>
        <BorrowedSessionPaneBody session={session} onOpen={vi.fn()} />
      </PaneFocusContext.Provider>
      <div data-testid="main-switch">
        <NativeChatViewSwitch worktreeId="folder" unifiedTabId="unified" />
      </div>
    </TooltipProvider>
  )
}
function lastPortal() {
  return mocks.publish.mock.calls.findLast(([targets]) => targets.length > 0)![0][0]
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.store.setState({
    settings: { experimentalNativeChat: true },
    unifiedTabsByWorktree: {
      folder: [
        {
          id: 'unified',
          entityId: 'terminal',
          worktreeId: 'folder',
          contentType: 'terminal',
          executionHostId: 'local',
          viewMode: 'terminal',
          label: 'Claude'
        }
      ]
    },
    tabsByWorktree: { folder: [{ id: 'terminal', launchAgent: 'claude', title: 'Claude' }] },
    terminalLayoutsByTabId: {
      terminal: { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
    },
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    setTabViewMode: (id, viewMode) =>
      mocks.store.setState((state) => ({
        unifiedTabsByWorktree: {
          folder: state.unifiedTabsByWorktree.folder.map((tab) =>
            tab.id === id ? { ...tab, viewMode } : tab
          )
        }
      }))
  } as unknown as AppState)
})
afterEach(() => {
  cleanup()
})

describe('borrowed session view', () => {
  it('keeps one borrowed target and shared view state across Chat / Terminal switches', () => {
    const view = render(body())
    const portal = lastPortal()
    // The retained main tab renders its existing switch inside the borrowed target.
    const pane = render(
      <TooltipProvider>
        <NativeChatViewSwitch worktreeId="folder" unifiedTabId="unified" />
      </TooltipProvider>,
      { container: portal.target }
    )
    const chat = within(portal.target).getByRole('radio', { name: 'Chat' })
    fireEvent.click(chat)
    expect(
      within(screen.getByTestId('main-switch'))
        .getByRole('radio', { name: 'Chat' })
        .getAttribute('data-state')
    ).toBe('on')
    expect(lastPortal()).toBe(portal)
    const terminal = within(screen.getByTestId('main-switch')).getByRole('radio', {
      name: 'Terminal'
    })
    fireEvent.click(terminal)
    expect(
      within(portal.target).getByRole('radio', { name: 'Terminal' }).getAttribute('data-state')
    ).toBe('on')
    expect(lastPortal()).toBe(portal)
    expect(mocks.mount).toHaveBeenCalledExactlyOnceWith({
      worktreeId: 'folder',
      tabIds: ['terminal']
    })
    expect(mocks.store.getState().unifiedTabsByWorktree.folder[0].entityId).toBe('terminal')
    pane.unmount()
    view.unmount()
  })
  it('publishes passive viewing and hide/restore without changing the target or tab', () => {
    const view = render(body())
    const portal = lastPortal()
    expect(portal).toMatchObject({
      passiveViewer: true,
      mounted: true,
      visible: true,
      tabId: 'terminal',
      paneKey: ''
    })
    view.rerender(body(false))
    expect(lastPortal().target).toBe(portal.target)
    expect(lastPortal().visible).toBe(false)
    view.rerender(body(true))
    expect(lastPortal().target).toBe(portal.target)
    expect(lastPortal().visible).toBe(true)
    view.unmount()
    expect(mocks.publish.mock.calls.at(-1)).toEqual([[], portal.slotId])
  })
  it('uses the main switch explanation when Chat UI is off', () => {
    act(() => mocks.store.setState({ settings: { experimentalNativeChat: false } } as AppState))
    render(body())
    const chat = screen.getByRole('radio', { name: 'Chat' })
    expect(chat.hasAttribute('disabled')).toBe(true)
    expect(chat.getAttribute('title')).toBe('Turn on Chat UI in Settings › Experimental.')
    fireEvent.click(chat)
    expect(mocks.store.getState().unifiedTabsByWorktree.folder[0].viewMode).toBe('terminal')
  })
  it('explains an unsupported agent and keeps its terminal', () => {
    act(() =>
      mocks.store.setState({
        tabsByWorktree: { folder: [{ id: 'terminal', launchAgent: 'gemini', title: 'Gemini' }] }
      } as unknown as AppState)
    )
    render(body())
    expect(screen.getByRole('radio', { name: 'Chat' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('title')).toBe(
      'This session has no chat view here, so it stays in Terminal.'
    )
    expect(lastPortal().tabId).toBe('terminal')
  })
  it('rejects another owner without mounting or borrowing a local terminal', () => {
    render(
      <BorrowedSessionPaneBody session={{ ...session, hostId: 'runtime:other' }} onOpen={vi.fn()} />
    )
    expect(screen.getByRole('status')).toBeTruthy()
    expect(mocks.mount).not.toHaveBeenCalled()
    expect(mocks.publish.mock.calls.every(([targets]) => targets.length === 0)).toBe(true)
  })
})
