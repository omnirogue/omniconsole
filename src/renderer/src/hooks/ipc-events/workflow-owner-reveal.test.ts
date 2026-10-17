import { describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  state: {
    isNavigatingHistory: false,
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    setActiveTab: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    createTab: vi.fn()
  }
}))
const surface = vi.hoisted(() => ({ focusTerminalTabSurface: vi.fn() }))

vi.mock('../../store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('@/lib/focus-terminal-tab-surface', () => surface)
vi.mock('@/runtime/sync-runtime-graph', () => ({ focusRuntimeTerminalSurface: () => false }))

import { focusTerminalFromHost } from './terminal-ui-routing-ipc-bridge'

describe('the owner window opening a workflow a paired computer asked for (step 9)', () => {
  // What `session.workflows.open` sends its own window: notifier.focusTerminal(tab, worktree, null).
  it('selects the anchor tab in its workspace and starts no terminal', () => {
    focusTerminalFromHost({ tabId: 'flow-tab', worktreeId: 'repo::/work', leafId: null })

    expect(store.state.setActiveView).toHaveBeenCalledWith('terminal')
    expect(store.state.setActiveWorktree).toHaveBeenCalledWith('repo::/work')
    expect(store.state.setActiveTab).toHaveBeenCalledWith('flow-tab')
    expect(store.state.revealWorktreeInSidebar).toHaveBeenCalledWith('repo::/work')
    expect(surface.focusTerminalTabSurface).toHaveBeenCalledWith('flow-tab', null)
    expect(store.state.createTab).not.toHaveBeenCalled()
  })
})
