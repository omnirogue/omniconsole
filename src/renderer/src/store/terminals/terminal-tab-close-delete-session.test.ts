import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const mockApi = createStoreCascadesMockApi()

const WORKTREE = 'local-repo::/tmp/app'
const SHARED_PTY = 'local-repo::/tmp/app@@9369dd50'
const MIRROR = 'web-terminal-7f2cf1c5'

/**
 * One daemon session listed by several rows, as a replayed create and its paired-host mirror
 * row leave them; each row's own pane (its layout leaf) binds that session.
 */
function storeWithRows(ids: readonly string[]): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const layout = (leafId: string) => ({
    root: null,
    activeLeafId: null,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: SHARED_PTY }
  })
  seedStore(store, {
    repos: [{ id: 'local-repo', path: '/tmp/app', name: 'app', executionHostId: 'local' }] as never,
    worktreesByRepo: {
      'local-repo': [makeWorktree({ id: WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
    },
    tabsByWorktree: {
      [WORKTREE]: ids.map((id) => makeTab({ id, worktreeId: WORKTREE, ptyId: SHARED_PTY }))
    },
    ptyIdsByTabId: Object.fromEntries(ids.map((id) => [id, [SHARED_PTY]])),
    terminalLayoutsByTabId: Object.fromEntries(ids.map((id) => [id, layout(`leaf-${id}`)]))
  })
  return store
}

const tabIds = (store: ReturnType<typeof createTestStore>): string[] | undefined =>
  store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)

describe('closeTab as a delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('kills the pane PTY although a paired-host mirror row still lists it', () => {
    const store = storeWithRows(['deleted-tab', MIRROR])

    store.getState().closeTab('deleted-tab', { reason: 'user', deleteSession: true })

    expect(mockApi.pty.kill).toHaveBeenCalledTimes(1)
    expect(mockApi.pty.kill).toHaveBeenCalledWith(SHARED_PTY)
    expect(tabIds(store)).toEqual([MIRROR])
  })

  it('keeps the PTY when another live, non-mirror tab still shows it', () => {
    const store = storeWithRows(['deleted-tab', MIRROR, 'second-presented-tab'])

    store.getState().closeTab('deleted-tab', { reason: 'user', deleteSession: true })

    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(tabIds(store)).toEqual([MIRROR, 'second-presented-tab'])
  })

  it('kills the PTY once when the sibling rows are deleted one after the other', () => {
    const store = storeWithRows(['deleted-tab', MIRROR, 'second-presented-tab'])

    store.getState().closeTab('deleted-tab', { reason: 'user', deleteSession: true })
    store.getState().closeTab('second-presented-tab', { reason: 'user', deleteSession: true })

    expect(mockApi.pty.kill).toHaveBeenCalledTimes(1)
    expect(mockApi.pty.kill).toHaveBeenCalledWith(SHARED_PTY)
    expect(tabIds(store)).toEqual([MIRROR])
  })

  it('kills nothing on a row-only delete (a session this computer could not verify)', () => {
    const store = storeWithRows(['deleted-tab'])

    store
      .getState()
      .closeTab('deleted-tab', { reason: 'user', localPtyTeardownOwnedExternally: true })

    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(tabIds(store)).toEqual([])
  })

  it('leaves a PTY another row lists alone on an ordinary close', () => {
    const store = storeWithRows(['deleted-tab', MIRROR])

    store.getState().closeTab('deleted-tab', { reason: 'user' })

    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(tabIds(store)).toEqual([MIRROR])
  })
})
