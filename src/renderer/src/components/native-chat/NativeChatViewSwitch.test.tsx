import { setNativeChatLeaf, useNativeChatLeafState } from './native-chat-leaf-state'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatViewSwitch } from './NativeChatViewSwitch'

const mocks = vi.hoisted(() => ({
  switchView: vi.fn(),
  isChat: true,
  state: {
    settings: { experimentalNativeChat: true },
    terminalLayoutsByTabId: {
      terminal: {
        root: { type: 'leaf', leafId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        activeLeafId: null,
        expandedLeafId: null
      }
    },
    unifiedTabsByWorktree: { workspace: [{ id: 'sdk', contentType: 'agent-session' }] }
  }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.state)
}))
vi.mock('./switch-native-chat-view', () => ({ switchNativeChatView: mocks.switchView }))
vi.mock('./native-chat-tab-toggle', () => ({
  findUnifiedTabIdForTerminalTab: () => null,
  resolveNativeChatTabToggle: () => ({
    unifiedTabId: 'pty',
    hasAgent: true,
    eligible: true,
    isChat: mocks.isChat
  })
}))
afterEach(() => {
  mocks.isChat = true
  cleanup()
  useNativeChatLeafState.setState({ nativeChatLeafByTabId: {} })
  vi.clearAllMocks()
})

it('routes the PTY header control through the common transition handler', () => {
  render(
    <TooltipProvider>
      <NativeChatViewSwitch worktreeId="workspace" unifiedTabId="pty" />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('radio', { name: 'Terminal' }))
  expect(mocks.switchView).toHaveBeenCalledExactlyOnceWith('workspace', 'pty', 'terminal', {
    paneKey: undefined
  })
})

it('keeps structured sessions in chat with a focusable disabled terminal explanation', () => {
  const view = render(
    <TooltipProvider>
      <NativeChatViewSwitch worktreeId="workspace" unifiedTabId="sdk" />
    </TooltipProvider>
  )
  const terminal = screen.getByRole('radio', { name: 'Terminal' })
  expect(terminal.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(terminal)
  expect(mocks.switchView).not.toHaveBeenCalled()
  expect(view.container.querySelector('[data-native-chat-switch="chat"]')).not.toBeNull()
})

it('preserves the Terminal toggle pressed state when enabled', () => {
  mocks.isChat = false
  render(
    <TooltipProvider>
      <NativeChatViewSwitch worktreeId="workspace" unifiedTabId="pty" />
    </TooltipProvider>
  )
  expect(screen.getByRole('radio', { name: 'Terminal' }).getAttribute('data-state')).toBe('on')
  expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('data-state')).toBe('off')
})

it('shows Terminal on a sibling leaf and routes its Chat click to that leaf', () => {
  const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  setNativeChatLeaf('terminal', first)
  const view = render(
    <TooltipProvider>
      <NativeChatViewSwitch
        worktreeId="workspace"
        unifiedTabId="pty"
        paneKey={`terminal:${first}`}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('data-state')).toBe('on')
  view.rerender(
    <TooltipProvider>
      <NativeChatViewSwitch
        worktreeId="workspace"
        unifiedTabId="pty"
        paneKey={`terminal:${second}`}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('radio', { name: 'Terminal' }).getAttribute('data-state')).toBe('on')
  fireEvent.click(screen.getByRole('radio', { name: 'Chat' }))
  expect(mocks.switchView).toHaveBeenCalledWith('workspace', 'pty', 'chat', {
    paneKey: `terminal:${second}`
  })
})

it('shows the restored chat owner before the pane has registered ownership', () => {
  render(
    <TooltipProvider>
      <NativeChatViewSwitch
        worktreeId="workspace"
        unifiedTabId="pty"
        paneKey="terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('data-state')).toBe('on')
})
