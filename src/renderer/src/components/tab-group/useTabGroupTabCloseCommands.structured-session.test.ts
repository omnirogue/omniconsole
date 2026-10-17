import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactModule from 'react'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeFile: vi.fn(),
  closeStructuredAgentSession: vi.fn(),
  closeTerminalTab: vi.fn(),
  closeUnifiedTab: vi.fn(),
  setActiveWorktree: vi.fn(),
  toastError: vi.fn()
}))

const store = vi.hoisted(() => ({
  activeWorktreeId: 'wt-1',
  browserPagesByWorkspace: {},
  browserTabsByWorktree: {},
  closeBrowserTab: mocks.closeBrowserTab,
  closeFile: mocks.closeFile,
  closeUnifiedTab: mocks.closeUnifiedTab,
  openFiles: [],
  reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
  setActiveWorktree: mocks.setActiveWorktree,
  tabsByWorktree: {},
  unifiedTabsByWorktree: {}
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react')
  return { ...actual, useCallback: <T>(callback: T) => callback }
})

vi.mock('../../store', () => ({
  useAppStore: Object.assign((selector: (state: typeof store) => unknown) => selector(store), {
    getState: () => store
  })
}))

vi.mock('../../store/slices/browser-webview-cleanup', () => ({
  destroyWorkspaceWebviews: vi.fn()
}))

vi.mock('../editor/editor-autosave', () => ({
  requestEditorFileClose: vi.fn()
}))

vi.mock('../terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: () => false
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => `id:${worktreeId}`
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'

const AGENT_TAB = {
  id: 'agent-tab-1',
  entityId: 'session-1',
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'agent-session' as const,
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.closeStructuredAgentSession.mockResolvedValue('closed')
  mocks.callRuntimeRpc.mockResolvedValue({ ok: true })
})

describe('native agent-session close routing', () => {
  it('routes the tab close through the same completion path as routine deletion', () => {
    const { closeItem } = useTabGroupTabCloseCommands({
      worktreeId: 'wt-1',
      groupTabs: [AGENT_TAB]
    })
    closeItem(AGENT_TAB.id)
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(AGENT_TAB.id, {
      onClosed: expect.any(Function)
    })
    expect(mocks.closeStructuredAgentSession).not.toHaveBeenCalled()
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('routes bulk native closes through the same owner and binding cleanup', () => {
    const { closeMany } = useTabGroupTabCloseCommands({
      worktreeId: 'wt-1',
      groupTabs: [AGENT_TAB]
    })
    closeMany([AGENT_TAB.id])
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(AGENT_TAB.id, {
      skipRunningProcessConfirm: true
    })
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('preserves the pinned native tab guard', () => {
    const { closeItem, closeMany } = useTabGroupTabCloseCommands({
      worktreeId: 'wt-1',
      groupTabs: [{ ...AGENT_TAB, isPinned: true }]
    })
    closeItem(AGENT_TAB.id)
    closeMany([AGENT_TAB.id])
    expect(mocks.closeTerminalTab).not.toHaveBeenCalled()
  })
})
