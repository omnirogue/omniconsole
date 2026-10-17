import { restoreCompiledLegacyChain } from './session-chain-legacy.fixture'
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSessionChain,
  loadSessionChains,
  resetSessionChainsForTests
} from './session-chain-runner'

const mocks = vi.hoisted(() => ({
  waits: vi.fn(),
  finished: vi.fn(),
  returned: vi.fn(),
  list: vi.fn(),
  persist: vi.fn(async (_target: unknown, chain: unknown) => chain),
  close: vi.fn(async () => true)
}))
vi.mock('@/lib/session-chain-waits', () => ({ waitForAllStops: mocks.waits }))
vi.mock('@/lib/close-session-tab', () => ({
  closeSessionTab: mocks.close,
  sessionTabIsOpen: () => true,
  sessionTabHasUnfinishedAgent: () => false
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/store/wait-later-store', () => ({
  useWaitLater: {
    getState: () => ({ setFinished: mocks.finished, setReturned: mocks.returned })
  }
}))
vi.mock('@/lib/session-chain-client', () => ({
  listSessionChainsFromHost: mocks.list,
  upsertSessionChainOnHost: mocks.persist
}))
vi.mock('@/lib/session-chain-launch', () => ({
  launchSessionChainStep: async (access: {
    getChain: () => { steps: object[] }
    update: (patch: object) => void
  }) => {
    access.update({
      currentIndex: 1,
      steps: [{ ...access.getChain().steps[0], launchedPaneKey: 'next:pane' }]
    })
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      getKnownWorktreeById: () => ({ path: '/w' }),
      agentStatusByPaneKey: {},
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true
    }),
    subscribe: () => () => undefined
  }
}))
const SOURCE_PANE = 't:11111111-1111-4111-8111-111111111111'
const session = {
  rowKey: 'row',
  sessionKey: null,
  worktreeId: 'w',
  hostId: 'local' as const,
  tabId: 't',
  paneKey: SOURCE_PANE,
  kind: 'terminal' as const,
  label: 'Build',
  workspaceLabel: 'Repo',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}
const steps = [{ id: 's', agent: 'claude' as const, prompt: 'Improve', status: 'queued' as const }]
afterEach(() => {
  resetSessionChainsForTests()
  vi.clearAllMocks()
})

describe('chain ending', () => {
  it('finishes a pre-Wave-3 chain loaded from disk without creating a new compiled chain', async () => {
    const persisted = {
      id: 'pre-wave-3',
      workspacePath: '/w',
      worktreeId: 'w',
      hostId: 'local',
      sourcePaneKey: SOURCE_PANE,
      sourceRowKey: 'row',
      auto: true,
      end: 'done',
      steps: [
        { id: 'legacy-step', agent: 'claude', prompt: 'Improve', group: 'g1', status: 'queued' }
      ],
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    }
    mocks.list.mockResolvedValueOnce([JSON.parse(JSON.stringify(persisted))])
    let finish!: () => void
    mocks.waits.mockResolvedValueOnce([{ handle: 'source', exited: false }]).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )

    await loadSessionChains()
    await vi.waitFor(() => expect(mocks.waits).toHaveBeenCalledTimes(2))
    expect(mocks.waits.mock.calls[1]?.[1]).toEqual(['next:pane'])
    expect(mocks.finished).not.toHaveBeenCalled()
    expect(getSessionChain(persisted.id)?.outcomeSet).toBeUndefined()
    finish()

    await vi.waitFor(() => expect(getSessionChain(persisted.id)?.state).toBe('done'))
    expect(mocks.finished).toHaveBeenCalledWith(`pane:${SOURCE_PANE}`, expect.any(Date))
    expect(mocks.persist).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: persisted.id,
        state: 'done',
        currentIndex: 1,
        steps: [
          expect.objectContaining({ id: 'legacy-step', group: 'g1', launchedPaneKey: 'next:pane' })
        ]
      })
    )
    expect(mocks.list).toHaveBeenCalledOnce()
  })

  it('marks the source finished only after the last launched pane completes', async () => {
    let finish!: () => void
    mocks.waits.mockResolvedValueOnce([{ handle: 'source', exited: false }]).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    restoreCompiledLegacyChain({ session, steps, chainId: 'done-chain', auto: true, end: 'done' })
    await vi.waitFor(() => expect(mocks.waits).toHaveBeenCalledTimes(2))
    expect(mocks.waits.mock.calls[1]?.[1]).toEqual(['next:pane'])
    expect(mocks.finished).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() =>
      expect(mocks.finished).toHaveBeenCalledWith(`pane:${SOURCE_PANE}`, expect.any(Date))
    )
    expect(getSessionChain('done-chain')?.state).toBe('done')
  })
  it('treats a pane the person closed as finished instead of failing the plan', async () => {
    mocks.waits
      .mockResolvedValueOnce([{ handle: 'source', exited: false }])
      .mockRejectedValueOnce(new Error('The session pane could not be found.'))
    restoreCompiledLegacyChain({ session, steps, chainId: 'gone-chain', auto: true, end: 'done' })
    await vi.waitFor(() =>
      expect(mocks.finished).toHaveBeenCalledWith(`pane:${SOURCE_PANE}`, expect.any(Date))
    )
    expect(getSessionChain('gone-chain')?.state).toBe('done')
  })
  it('hands the conversation back only after the last launched pane completes', async () => {
    let finish!: () => void
    mocks.waits.mockResolvedValueOnce([{ handle: 'source', exited: false }]).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    restoreCompiledLegacyChain({ session, steps, chainId: 'me-chain', auto: true, end: 'me' })
    await vi.waitFor(() => expect(mocks.waits).toHaveBeenCalledTimes(2))
    expect(mocks.returned).not.toHaveBeenCalled()
    expect(getSessionChain('me-chain')?.state).not.toBe('done')
    finish()
    await vi.waitFor(() =>
      expect(mocks.returned).toHaveBeenCalledWith(`pane:${SOURCE_PANE}`, expect.any(Date))
    )
    expect(mocks.finished).not.toHaveBeenCalled()
    expect(getSessionChain('me-chain')?.state).toBe('done')
  })
  it('✓ with nobody after it waits on the session itself, then ends and closes it', async () => {
    let finish!: (value: unknown) => void
    mocks.waits.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const chain = restoreCompiledLegacyChain({
      session,
      steps: [],
      chainId: 'end-only',
      auto: true,
      end: 'done'
    })
    expect(chain?.steps).toEqual([])
    await vi.waitFor(() => expect(mocks.waits).toHaveBeenCalledTimes(1))
    expect(mocks.waits.mock.calls[0]?.[1]).toEqual([SOURCE_PANE])
    // Why: nothing closes while the session is still working.
    expect(mocks.close).not.toHaveBeenCalled()
    expect(getSessionChain('end-only')?.state).toBe('waiting')
    finish([{ handle: 'source', exited: false }])
    await vi.waitFor(() => expect(getSessionChain('end-only')?.state).toBe('done'))
    expect(mocks.finished).toHaveBeenCalledWith(`pane:${SOURCE_PANE}`, expect.any(Date))
    expect(mocks.close).toHaveBeenCalledWith('t', { rejectPinned: true })
  })
  it('refuses a plan with no steps unless it ends the session', () => {
    expect(
      restoreCompiledLegacyChain({ session, steps: [], chainId: 'empty', auto: true, end: 'me' })
    ).toBeNull()
    expect(
      restoreCompiledLegacyChain({ session, steps: [], chainId: 'bare', auto: true })
    ).toBeNull()
  })
})
