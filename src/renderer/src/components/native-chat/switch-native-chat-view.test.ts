import { useNativeChatLeafState } from './native-chat-leaf-state'
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { switchNativeChatView } from './switch-native-chat-view'

const mocks = vi.hoisted(() => ({
  state: {
    unifiedTabsByWorktree: {
      workspace: [
        { id: 'unified', entityId: 'pty-tab', contentType: 'terminal', viewMode: 'terminal' },
        { id: 'other', entityId: 'other-pty', contentType: 'terminal', viewMode: 'terminal' },
        { id: 'sdk', entityId: 'session', contentType: 'agent-session', viewMode: 'chat' }
      ]
    },
    tabsByWorktree: { workspace: [{ id: 'pty-tab', launchAgent: 'claude' }] },
    terminalLayoutsByTabId: { 'pty-tab': { activeLeafId: 'leaf' } },
    setTabViewMode: vi.fn()
  },
  telemetry: vi.fn(),
  eligible: true,
  focusTerminal: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminal
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatToggled: mocks.telemetry }))
vi.mock('./native-chat-tab-toggle', () => ({
  resolveNativeChatTabToggle: () => ({ eligible: mocks.eligible })
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.eligible = true
  mocks.state.unifiedTabsByWorktree.workspace[0].viewMode = 'terminal'
  mocks.state.setTabViewMode.mockImplementation((id, mode) => {
    mocks.state.unifiedTabsByWorktree.workspace.find((tab) => tab.id === id)!.viewMode = mode
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  document.body.innerHTML =
    '<div data-terminal-tab-id="pty-tab"><div data-leaf-id="leaf"><textarea class="xterm-helper-textarea"></textarea></div><div class="native-chat-pane-shell"><div data-native-chat-root><input aria-label="Search" /><div data-native-chat-composer><textarea></textarea></div></div></div></div>'
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('switchNativeChatView', () => {
  it('changes only the requested tab and focuses its chat input', () => {
    switchNativeChatView('workspace', 'unified', 'chat')
    expect(mocks.state.setTabViewMode).toHaveBeenCalledWith('unified', 'chat')
    expect(mocks.state.unifiedTabsByWorktree.workspace[1].viewMode).toBe('terminal')
    expect(document.activeElement).toBe(document.querySelector('[data-native-chat-root] textarea'))
  })
  it('focuses the same terminal leaf without resetting conversation state', () => {
    switchNativeChatView('workspace', 'unified', 'terminal')
    expect(mocks.state.setTabViewMode).toHaveBeenCalledExactlyOnceWith('unified', 'terminal')
    expect(mocks.focusTerminal).toHaveBeenCalledWith('pty-tab', 'leaf', { refreshImeContext: true })
  })
  it('cancels stale focus when switches happen within the same frame', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    switchNativeChatView('workspace', 'unified', 'terminal')
    switchNativeChatView('workspace', 'unified', 'chat')
    frames.forEach((frame) => frame(0))
    expect(mocks.focusTerminal).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(document.querySelector('[data-native-chat-root] textarea'))
  })
  it('rejects unsupported chat and structured terminal transitions', () => {
    mocks.eligible = false
    switchNativeChatView('workspace', 'unified', 'chat')
    switchNativeChatView('workspace', 'sdk', 'terminal')
    switchNativeChatView('workspace', 'missing', 'chat')
    expect(mocks.state.setTabViewMode).not.toHaveBeenCalled()
  })
  it('routes header, in-chat affordances and pane exits through the same handler', () => {
    const header = readFileSync(new NodeURL('./NativeChatViewSwitch.tsx', import.meta.url), 'utf8')
    const resolved = readFileSync(
      new NodeURL('./NativeChatResolvedView.tsx', import.meta.url),
      'utf8'
    )
    const pane = readFileSync(
      new NodeURL('../terminal-pane/TerminalPane.tsx', import.meta.url),
      'utf8'
    )
    expect(header).toContain('switchNativeChatView(worktreeId, toggle.id, value, {')
    expect(resolved).toContain('onReview={onSwitchToTerminal}')
    expect(resolved).toContain('onSwitchToTerminal={onSwitchToTerminal}')
    expect(pane).toContain('onSwitchToTerminal={switchNativeChatToTerminal}')
    const route = readFileSync(
      new NodeURL('./use-native-chat-leaf-route.ts', import.meta.url),
      'utf8'
    )
    expect(route).toContain("switchNativeChatView(worktreeId, unifiedTabId, 'terminal', {")
    expect(route).toContain('emitTelemetry: false')
    expect(header + pane).not.toContain('setTabViewMode(')
  })
})

it('does not move focus for lifecycle transitions', () => {
  mocks.state.unifiedTabsByWorktree.workspace[0].viewMode = 'chat'
  const search = document.querySelector('input')!
  search.focus()
  switchNativeChatView('workspace', 'unified', 'terminal', { focus: false })
  expect(mocks.state.setTabViewMode).toHaveBeenCalledWith('unified', 'terminal')
  expect(mocks.focusTerminal).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(search)
})

it('emits telemetry once per changed mode, including lifecycle transitions', () => {
  switchNativeChatView('workspace', 'unified', 'chat')
  switchNativeChatView('workspace', 'unified', 'chat')
  switchNativeChatView('workspace', 'unified', 'terminal', { focus: false })
  expect(mocks.telemetry.mock.calls).toEqual([
    [{ from: 'terminal', to: 'chat', agent: 'claude' }],
    [{ from: 'chat', to: 'terminal', agent: 'claude' }]
  ])
})

it('routes Chat to the requested leaf even when the tab is already in Chat', () => {
  const leafId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  mocks.state.unifiedTabsByWorktree.workspace[0].viewMode = 'chat'
  switchNativeChatView('workspace', 'unified', 'chat', {
    paneKey: `pty-tab:${leafId}`,
    focus: false
  })
  expect(useNativeChatLeafState.getState().nativeChatLeafByTabId['pty-tab']).toBe(leafId)
})
