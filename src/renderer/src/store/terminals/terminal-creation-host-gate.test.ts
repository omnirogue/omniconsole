// @vitest-environment happy-dom
import type { AppState } from '../types'
import type * as WebRuntimeSession from '@/runtime/web-runtime-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore, TEST_REPO } from '../slices/store-test-helpers'
import {
  resolveTerminalCreationRoute,
  getRemoteConnectionIdForWorktree
} from './terminal-workspace-routing'

const launchStore = vi.hoisted(() => ({ state: {} as AppState }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => launchStore.state } }))
const remote = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeSession>()),
  createWebRuntimeSessionTerminal: remote
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const WT = 'repo1::/repo1'
function localStore() {
  const store = createTestStore()
  seedStore(store, { worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1' })] } })
  return store
}

beforeEach(() => vi.clearAllMocks())

describe('terminal creation requires a resolved execution host', () => {
  it('creates a tab only for a known local connection', () => {
    const store = localStore()
    expect(resolveTerminalCreationRoute(store.getState(), WT)).toEqual({
      runtimeEnvironmentId: null,
      connectionId: null
    })
    const tab = store.getState().createTab(WT)
    expect(store.getState().tabsByWorktree[WT]).toContainEqual(tab)
  })

  it.each([WT, 'folder:missing'])(
    'refuses an unresolved workspace %s before any store mutation',
    async (worktreeId) => {
      const store = localStore()
      store.setState({ repos: [], worktreesByRepo: {}, activeWorktreeId: worktreeId })
      const before = store.getState()
      expect(getRemoteConnectionIdForWorktree(before, worktreeId)).toBeUndefined()
      expect(() => before.createTab(worktreeId)).toThrow('unresolved')
      expect(store.getState()).toBe(before)
      await before.openNewTerminalTabInActiveWorkspace('group-1')
      expect(store.getState()).toBe(before)
      expect(remote).not.toHaveBeenCalled()
    }
  )

  it('refuses a disconnected SSH workspace and creates no local tab', async () => {
    const store = localStore()
    store.setState({
      repos: [{ ...TEST_REPO, connectionId: 'other', executionHostId: 'ssh:other' }],
      activeWorktreeId: WT
    })
    const before = store.getState()
    expect(() => before.createTab(WT)).toThrow('disconnected')
    await before.openNewTerminalTabInActiveWorkspace('group-1')
    expect(store.getState()).toBe(before)
    expect(remote).not.toHaveBeenCalled()
  })

  it('refuses ambiguous paired owners before creating any terminal', async () => {
    const store = localStore()
    store.setState({
      repos: [
        { ...TEST_REPO, executionHostId: 'runtime:hub-a' },
        { ...TEST_REPO, executionHostId: 'runtime:hub-b' }
      ],
      activeWorktreeId: WT
    })
    const before = store.getState()
    expect(() => before.createTab(WT)).toThrow('unresolved')
    await before.openNewTerminalTabInActiveWorkspace('group-1')
    expect(store.getState()).toBe(before)
    expect(remote).not.toHaveBeenCalled()
  })

  it('keeps a paired workspace on its remote route even when the request fails', async () => {
    const store = localStore()
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:other' }],
      activeWorktreeId: WT
    })
    const before = store.getState()
    expect(() => before.createTab(WT)).toThrow('paired terminal route')
    remote.mockRejectedValueOnce(new Error('disconnected'))
    await expect(before.openNewTerminalTabInActiveWorkspace('group-1')).rejects.toThrow(
      'disconnected'
    )
    expect(remote).toHaveBeenCalledWith(expect.objectContaining({ environmentId: 'other' }))
    expect(store.getState()).toBe(before)
  })
})

describe('agent launch host refusal', () => {
  it.each(['unresolved', 'disconnected', 'ambiguous'])(
    'refuses %s ownership before a local launch',
    async (kind) => {
      const store = localStore()
      store.setState({
        repos:
          kind === 'ambiguous'
            ? [
                { ...TEST_REPO, executionHostId: 'runtime:hub-a' },
                { ...TEST_REPO, executionHostId: 'runtime:hub-b' }
              ]
            : kind === 'unresolved'
              ? []
              : [{ ...TEST_REPO, connectionId: 'offline' }]
      })
      const createTab = vi.fn()
      const queueTabStartupCommand = vi.fn()
      launchStore.state = { ...store.getState(), createTab, queueTabStartupCommand }
      const { launchAgentInNewTab } = await import('@/lib/launch-agent-in-new-tab')
      expect(launchAgentInNewTab({ agent: 'claude', worktreeId: WT })).toBeNull()
      expect(createTab).not.toHaveBeenCalled()
      expect(queueTabStartupCommand).not.toHaveBeenCalled()
      expect(remote).not.toHaveBeenCalled()
    }
  )
})
