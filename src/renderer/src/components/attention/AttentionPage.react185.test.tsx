/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { mountOnRealStore, resetRealStore, type RealStoreMount } from '@/test/mount-on-real-store'

// Why: the slot tests replace the store with a plain selector call, which hides Zustand's
// snapshot-identity loop. This test keeps the real store and stubs only the strips that read
// detection, settings, tab and session state covered elsewhere.
vi.mock('../activity/activity-terminal-portal', () => ({ setActivityTerminalPortals: vi.fn() }))
vi.mock('../terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))
vi.mock('../next-action/UpNextControls', () => ({ UpNextControls: () => null }))
vi.mock('../next-action/UpNextPopover', () => ({ UpNextPopover: () => null }))
vi.mock('../sidebar/session-folders/use-sidebar-sessions', () => ({ useSidebarSessions: () => [] }))
vi.mock('@/lib/session-chain-registry', () => ({
  useSessionChainForRow: () => null,
  // Why: the real pane snapshot reads the pursued runs; this page is tested with none.
  useShownSessionChains: () => []
}))
vi.mock('@/store/wait-later-store', () => ({
  useWaitingKeys: () => new Set<string>(),
  useFinishedMarks: () => new Map<string, number>()
}))
vi.mock('./AttentionLaunchBar', () => ({
  AttentionLaunchBar: () => <div data-attention-launch-bar="" />
}))
vi.mock('../native-chat/NativeChatViewSwitch', () => ({ NativeChatViewSwitch: () => null }))
import AttentionPage from './AttentionPage'

let mounted: RealStoreMount | null = null

beforeEach(() => {
  resetRealStore()
})

afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  resetRealStore()
  document.body.replaceChildren()
})

async function mountAttentionPage(): Promise<HTMLElement> {
  mounted = await mountOnRealStore(<AttentionPage />)
  return mounted.container
}

describe('AttentionPage on the real store (React #185)', () => {
  it('draws the empty state when no workspace is active instead of re-rendering forever', async () => {
    useAppStore.setState({ activeWorktreeId: null, activeTabId: null })

    const container = await mountAttentionPage()

    expect(container.querySelector('[data-attention-page]')).not.toBeNull()
    expect(container.textContent).toContain('Pick a session in the sidebar')
  })

  it('draws a workspace whose tabs have not registered yet', async () => {
    useAppStore.setState({ activeWorktreeId: 'w1', activeTabId: null, tabsByWorktree: {} })

    const container = await mountAttentionPage()

    expect(container.querySelector('[data-attention-page]')).not.toBeNull()
  })
})
