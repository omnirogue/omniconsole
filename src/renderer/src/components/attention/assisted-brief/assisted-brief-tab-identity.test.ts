import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '@/store/slices/store-test-helpers'
import { deriveBriefStartIdentity } from '../../../../../shared/assisted-brief-hash'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WORKTREE = 'repo1::/path/brief'
const { tabId } = deriveBriefStartIdentity('brief-1', 1, `sha256:${'ab'.repeat(32)}`)

function storeWithTabs(tabs: ReturnType<typeof makeTab>[]) {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/brief' })]
    },
    tabsByWorktree: { [WORKTREE]: tabs },
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  return store
}

// Why: Start finds its session after a restart only if the real store keeps the derived tab id.
describe('assisted-brief Start tab identity', () => {
  it('creates the Start tab under the id derived from the approved revision', () => {
    const tab = storeWithTabs([])
      .getState()
      .createTab(WORKTREE, undefined, undefined, { id: tabId })
    expect(tab.id).toBe(tabId)
  })

  it('gets a fresh id when the derived id is taken, which is why Start looks for it first', () => {
    const store = storeWithTabs([makeTab({ id: tabId, worktreeId: WORKTREE })])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(WORKTREE, undefined, undefined, { id: tabId })
      expect(tab.id).not.toBe(tabId)
    } finally {
      warn.mockRestore()
    }
  })
})
