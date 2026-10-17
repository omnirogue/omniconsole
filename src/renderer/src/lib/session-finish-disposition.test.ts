import type { SessionChain } from '../../../shared/session-chain-types'
import type { SessionRunDisposition } from '../../../shared/session-run-completion'
import type * as FolderStoreModule from '@/store/session-folders'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import type { SidebarSession } from './sidebar-sessions'

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  progress: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
  unfinished: vi.fn(),
  entries: vi.fn(),
  shown: vi.fn(),
  sessions: vi.fn(),
  view: vi.fn(),
  rpc: vi.fn(async (..._args: unknown[]) => ({})),
  state: { workspaceSessionReady: true }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./close-session-tab', () => ({
  closeSessionTab: mocks.close,
  sessionTabHasUnfinishedAgent: mocks.unfinished,
  sessionTabIsOpen: mocks.open
}))
vi.mock('./session-chain-registry', () => ({
  getSessionChain: () => null,
  findShownSessionChainForRow: mocks.shown,
  getAllSessionChainEntries: mocks.entries,
  subscribeSessionChains: () => () => {}
}))
vi.mock('./sidebar-sessions', () => ({ buildSidebarSessions: mocks.sessions }))
vi.mock('@/components/next-step/next-step-outcome-client', () => ({
  reportSessionDisposition: mocks.report,
  getOutcomeProgress: mocks.progress
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeTabId: 'tab',
      activeWorktreeId: 'w1',
      activeView: 'terminal',
      setActiveView: mocks.view,
      workspaceSessionReady: mocks.state.workspaceSessionReady
    })
  }
}))
vi.mock('@/store/session-folders', async (importOriginal) => {
  const actual = await importOriginal<typeof FolderStoreModule>()
  return {
    ...actual,
    useSessionFolders: actual.createSessionFoldersStore({
      load: () => ({ version: 1, folders: [], membership: {} }),
      save: () => {}
    })
  }
})
import { useSessionFolders } from '@/store/session-folders'
import { applyDueSessionFinishes, applySessionDisposition } from './session-finish-actions'

const NOW = 1_000_000
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'w1',
  hostId: 'local',
  tabId: 'tab',
  paneKey: 'tab:leaf',
  kind: 'terminal',
  label: 'Report',
  workspaceLabel: 'Reports',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}

/** The window remembers operations by id, so every test names its own. */
let operations = 0
function sealedChain(
  disposition: Partial<SessionRunDisposition> = {},
  extra: Partial<SessionChain> = {}
): SessionChain {
  operations += 1
  return {
    id: 'chain',
    hostId: 'local',
    sourceRowKey: 'row',
    outcomeSet: {
      revision: 3,
      completion: { at: 1, outcomes: [{ id: 'result', revision: 1 }], evidenceIds: [] },
      disposition: {
        intent: 'close',
        state: 'pending',
        operationId: `op_${operations}`,
        attempts: 0,
        updatedAt: 1,
        ...disposition
      }
    },
    ...extra
  } as unknown as SessionChain
}
const operationOf = (chain: SessionChain): string => chain.outcomeSet!.disposition!.operationId
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
  mocks.state.workspaceSessionReady = true
  mocks.open.mockReturnValue(true)
  mocks.unfinished.mockReturnValue(false)
  mocks.close.mockResolvedValue(true)
  mocks.report.mockImplementation(async ({ chain }: { chain: SessionChain }) => chain)
  mocks.entries.mockReturnValue([])
  mocks.sessions.mockReturnValue([session])
  mocks.shown.mockReturnValue(null)
})

describe('the host’s disposition record drives the window', () => {
  it('Completed asks nothing of any window: nothing is closed, saved or reported', async () => {
    const chain = sealedChain({ intent: 'completed', state: 'applied', appliedAt: 1 })
    await applySessionDisposition(session, chain, NOW)
    // Not even a record some older build left pending may close a run that only completed.
    await applySessionDisposition(session, sealedChain({ intent: 'completed' }), NOW)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report).not.toHaveBeenCalled()
    expect(useSessionFolders.getState().metadata.membership).toEqual({})
  })

  it('an explicit Close closes the tab once and reports it under the host’s operation', async () => {
    const chain = sealedChain()
    await applySessionDisposition(session, chain, NOW)
    expect(mocks.close).toHaveBeenCalledWith('tab', { rejectPinned: true })
    expect(mocks.report).toHaveBeenCalledWith({
      chain,
      operationId: operationOf(chain),
      ok: true
    })
    expect(useSessionFolders.getState().metadata.finishActions?.session).toMatchObject({
      action: 'end',
      chainId: 'chain',
      executionOwnerKey: 'local',
      revision: 3,
      applied: true,
      completedAt: NOW
    })
    // The registry still shows the old snapshot until the next poll: nothing is done twice.
    await applySessionDisposition(session, chain, NOW + 10)
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.report).toHaveBeenCalledOnce()
  })

  it('an explicit Save files the session in the host’s folder, without closing it', async () => {
    const folderId = useSessionFolders.getState().createFolder('Clients', 'saved')!
    const chain = sealedChain({ intent: 'save', folderId })
    await applySessionDisposition(session, chain, NOW)
    expect(useSessionFolders.getState().metadata.membership.session).toBe(folderId)
    // Recorded before it ran, as the app's finish.
    expect(mocks.rpc.mock.calls.map(([, method]) => method)).toEqual([
      'sessionOrganization.prepare',
      'sessionOrganization.settle'
    ])
    expect(mocks.rpc.mock.calls[0]![2]).toMatchObject({
      change: {
        kind: 'save',
        targets: [{ sessionKey: 'session' }],
        value: folderId,
        executor: { kind: 'app', feature: 'finish' }
      }
    })
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report).toHaveBeenCalledWith({ chain, operationId: operationOf(chain), ok: true })
    // A folder this device does not have falls back to Saved Sessions rather than failing.
    const elsewhere = sealedChain({ intent: 'save', folderId: 'folder-on-another-device' })
    await applySessionDisposition({ ...session, sessionKey: 'other' }, elsewhere, NOW)
    expect(useSessionFolders.getState().metadata.membership.other).toBe(SAVED_SESSIONS_FOLDER_ID)
  })

  it.each([
    [false, 'The session is pinned or declined to close.'],
    [null, 'Closing the session did not finish in time.']
  ])(
    'a close that came back %s is reported as failed, never as Closed, and waits for the host’s window',
    async (outcome, error) => {
      mocks.close.mockResolvedValue(outcome)
      const chain = sealedChain()
      mocks.report.mockResolvedValue(
        sealedChain({ operationId: operationOf(chain), attempts: 1, nextAttemptAt: NOW + 5_000 })
      )
      await applySessionDisposition(session, chain, NOW)
      expect(mocks.report).toHaveBeenCalledWith({
        chain,
        operationId: operationOf(chain),
        ok: false,
        error
      })
      expect(useSessionFolders.getState().metadata.finishActions?.session).toBeUndefined()
      // Before the host's next due time this window does not try, or report, again.
      await applySessionDisposition(session, chain, NOW + 4_999)
      expect(mocks.close).toHaveBeenCalledOnce()
      mocks.close.mockResolvedValue(true)
      await applySessionDisposition(session, chain, NOW + 5_000)
      expect(mocks.close).toHaveBeenCalledTimes(2)
      expect(mocks.report).toHaveBeenLastCalledWith({
        chain,
        operationId: operationOf(chain),
        ok: true
      })
    }
  )

  it('waits for the host’s own due time before retrying', async () => {
    const chain = sealedChain({ attempts: 1, nextAttemptAt: NOW + 30_000 })
    await applySessionDisposition(session, chain, NOW)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report).not.toHaveBeenCalled()
  })

  it('a tab that is already gone counts as closed', async () => {
    mocks.open.mockReturnValue(false)
    const gone = sealedChain()
    await applySessionDisposition(session, gone, NOW)
    const sleeping = sealedChain()
    await applySessionDisposition({ ...session, tabId: null }, sleeping, NOW)
    const rowless = sealedChain()
    await applySessionDisposition(null, rowless, NOW)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report.mock.calls.map((call) => call[0])).toEqual([
      { chain: gone, operationId: operationOf(gone), ok: true },
      { chain: sleeping, operationId: operationOf(sleeping), ok: true },
      { chain: rowless, operationId: operationOf(rowless), ok: true }
    ])
  })

  it('a close this device already performed under the legacy mirror is reported, not repeated', async () => {
    useSessionFolders.getState().setFinishAction('session', {
      action: 'end',
      folderId: SAVED_SESSIONS_FOLDER_ID,
      chainId: 'chain',
      revision: 3,
      applied: true
    })
    const chain = sealedChain()
    await applySessionDisposition(session, chain, NOW)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report).toHaveBeenCalledWith({ chain, operationId: operationOf(chain), ok: true })
  })

  it('cannot save a row this device no longer has, and says nothing until it can', async () => {
    await applySessionDisposition(null, sealedChain({ intent: 'save' }), NOW)
    expect(mocks.report).not.toHaveBeenCalled()
  })

  it('never cuts off a source that is still working or asking something', async () => {
    mocks.unfinished.mockReturnValue(true)
    await applySessionDisposition(session, sealedChain(), NOW)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report).not.toHaveBeenCalled()
  })

  it('acts only for its own row on its own execution host', async () => {
    await applySessionDisposition(session, sealedChain({}, { sourceRowKey: 'other-row' }), NOW)
    await applySessionDisposition(session, sealedChain({}, { hostId: 'runtime:other' }), NOW)
    await applySessionDisposition({ ...session, unavailable: true }, sealedChain(), NOW)
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report).not.toHaveBeenCalled()
  })

  it('an unreachable host keeps the disposition pending, and the next observation reports it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.report.mockRejectedValueOnce(new Error('host offline'))
    const chain = sealedChain()
    await applySessionDisposition(session, chain, NOW)
    expect(warn).toHaveBeenCalled()
    expect(useSessionFolders.getState().metadata.finishActions?.session).toBeUndefined()
    // The tab is gone by now; that is still the close the host asked for.
    mocks.open.mockReturnValue(false)
    await applySessionDisposition(session, chain, NOW + 5_000)
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.report).toHaveBeenLastCalledWith({
      chain,
      operationId: operationOf(chain),
      ok: true
    })
    warn.mockRestore()
  })
})

describe('one pass over what the window can see', () => {
  it('follows the host record and never lets a stale device mirror close a run that only completed', async () => {
    useSessionFolders.getState().setFinishAction('session', {
      action: 'end',
      folderId: SAVED_SESSIONS_FOLDER_ID,
      chainId: 'chain',
      executionOwnerKey: 'local',
      revision: 3,
      applied: false
    })
    const completed = sealedChain({ intent: 'completed', state: 'applied', appliedAt: 1 })
    mocks.entries.mockReturnValue([{ chain: completed }])
    mocks.shown.mockReturnValue(completed)
    applyDueSessionFinishes(NOW)
    await flush()
    expect(mocks.close).not.toHaveBeenCalled()
    expect(mocks.report).not.toHaveBeenCalled()
    expect(mocks.progress).not.toHaveBeenCalled()
  })

  it('applies every sealed run of a row, not only the chain the row currently shows', async () => {
    const sealed = sealedChain()
    const fork = { id: 'source_fork', hostId: 'local', sourceRowKey: 'row' } as SessionChain
    mocks.entries.mockReturnValue([{ chain: sealed }, { chain: fork }])
    mocks.shown.mockReturnValue(fork)
    applyDueSessionFinishes(NOW)
    await vi.waitFor(() =>
      expect(mocks.report).toHaveBeenCalledWith({
        chain: sealed,
        operationId: operationOf(sealed),
        ok: true
      })
    )
    expect(mocks.close).toHaveBeenCalledWith('tab', { rejectPinned: true })
  })

  it('reports a closed local source as gone only once the workspace is restored', async () => {
    const sealed = sealedChain()
    mocks.sessions.mockReturnValue([])
    mocks.entries.mockReturnValue([{ chain: sealed }])
    mocks.state.workspaceSessionReady = false
    applyDueSessionFinishes(NOW)
    await flush()
    expect(mocks.report).not.toHaveBeenCalled()
    mocks.state.workspaceSessionReady = true
    applyDueSessionFinishes(NOW)
    await vi.waitFor(() =>
      expect(mocks.report).toHaveBeenCalledWith({
        chain: sealed,
        operationId: operationOf(sealed),
        ok: true
      })
    )
    // Another host's rows may simply not be loaded here: their absence proves nothing.
    const remote = sealedChain({}, { hostId: 'runtime:peer' })
    mocks.entries.mockReturnValue([{ chain: remote }])
    applyDueSessionFinishes(NOW)
    await flush()
    expect(mocks.report).toHaveBeenCalledOnce()
  })
})
