import type { SessionChain } from '../../../shared/session-chain-types'
import type * as FolderStoreModule from '@/store/session-folders'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  emptySessionFolderMetadata,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFinishAction
} from './session-folders'
import type { SidebarSession } from './sidebar-sessions'
const mocks = vi.hoisted(() => ({
  progress: vi.fn(),
  close: vi.fn(),
  unfinished: vi.fn(),
  chain: vi.fn(),
  row: vi.fn(),
  view: vi.fn(),
  rpc: vi.fn(async (..._args: unknown[]) => ({}))
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
/** The organization records written, as `<phase or method> <kind> <executor>`. */
function records(): string[] {
  return mocks.rpc.mock.calls.map(([, method, params]) => {
    const { phase, change } = params as {
      phase?: string
      change: { kind: string; executor: { kind: string; feature?: string } }
    }
    const executor = [change.executor.kind, change.executor.feature].filter(Boolean).join('/')
    return `${phase ?? String(method).split('.')[1]} ${change.kind} ${executor}`
  })
}
vi.mock('./close-session-tab', () => ({
  closeSessionTab: mocks.close,
  sessionTabHasUnfinishedAgent: mocks.unfinished,
  sessionTabIsOpen: () => true
}))
vi.mock('./session-chain-registry', () => ({
  getSessionChain: mocks.chain,
  findShownSessionChainForRow: mocks.row,
  getAllSessionChainEntries: () => [],
  subscribeSessionChains: () => () => {}
}))
vi.mock('@/components/next-step/next-step-outcome-client', () => ({
  getOutcomeProgress: mocks.progress,
  reportSessionDisposition: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeTabId: 'tab',
      activeWorktreeId: 'w1',
      activeView: 'terminal',
      setActiveView: mocks.view
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
import {
  applySessionFinishAction,
  readSessionFinishAction,
  adoptSessionFinishAction
} from './session-finish-actions'
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
const action: SessionFinishAction = {
  action: 'save',
  folderId: SAVED_SESSIONS_FOLDER_ID,
  chainId: 'chain',
  revision: 3
}
function arm(value = action) {
  useSessionFolders.getState().setFinishAction('session', value)
  return useSessionFolders.getState().metadata.finishActions!.session!
}
/**
 * A chain from a host that predates the completion seal: it records the finish INTENT only, which
 * is the one case this device still carries out from its mirror — and only while the host says so.
 */
const hostChain = (finish: SessionFinishAction['action'] | null = 'save', revision = 3) => ({
  id: 'chain',
  sourceRowKey: 'row',
  outcomeSet: { revision, ...(finish ? { sessionFinish: { action: finish } } : {}) }
})
beforeEach(() => {
  vi.clearAllMocks()
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
  mocks.chain.mockReturnValue(hostChain())
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: hostChain() })
  mocks.unfinished.mockReturnValue(false)
  mocks.close.mockResolvedValue(true)
})
it('saves only after current host verification, without closing or sending another handoff', async () => {
  await applySessionFinishAction(session, arm())
  expect(mocks.progress).toHaveBeenCalledWith('chain', expect.any(Object), {
    verifySourceReady: true
  })
  expect(useSessionFolders.getState().metadata.membership.session).toBe(SAVED_SESSIONS_FOLDER_ID)
  expect(useSessionFolders.getState().metadata.finishActions?.session?.applied).toBe(true)
  expect(mocks.close).not.toHaveBeenCalled()
  expect(mocks.view).toHaveBeenCalledWith('attention')
  expect(records()).toEqual(['prepare save app/finish', 'applied save app/finish'])
})
it.each(['pending', 'needs-you', 'unverifiable'])(
  'keeps %s work visible and unclosed',
  async (lifecycle) => {
    mocks.progress.mockResolvedValue({ lifecycle, chain: hostChain() })
    await applySessionFinishAction(session, arm())
    expect(useSessionFolders.getState().metadata.membership).toEqual({})
    expect(mocks.close).not.toHaveBeenCalled()
  }
)
it('closes an End choice once, with pinned-session protection', async () => {
  mocks.chain.mockReturnValue(hostChain('end'))
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: hostChain('end') })
  await applySessionFinishAction(session, arm({ ...action, action: 'end' }))
  expect(mocks.close).toHaveBeenCalledWith('tab', { rejectPinned: true })
  await applySessionFinishAction(
    session,
    useSessionFolders.getState().metadata.finishActions!.session!
  )
  expect(mocks.close).toHaveBeenCalledOnce()
})
it('does not apply a stale revision or a choice changed during host verification', async () => {
  const old = arm()
  mocks.progress.mockImplementation(async () => {
    arm({ ...action, action: 'end' })
    return { lifecycle: 'complete', chain: hostChain() }
  })
  await applySessionFinishAction(session, old)
  expect(useSessionFolders.getState().metadata.membership).toEqual({})
  expect(mocks.close).not.toHaveBeenCalled()
  mocks.chain.mockReturnValue(hostChain('save', 4))
  await applySessionFinishAction(session, arm())
  expect(mocks.progress).toHaveBeenCalledOnce()
})
it('keeps the session when an agent becomes busy while verification is in flight', async () => {
  mocks.unfinished.mockReturnValueOnce(false).mockReturnValue(true)
  await applySessionFinishAction(session, arm())
  expect(mocks.close).not.toHaveBeenCalled()
  expect(useSessionFolders.getState().metadata.membership).toEqual({})
})
it('leaves a refused close pending without claiming completion of the close', async () => {
  mocks.chain.mockReturnValue(hostChain('end'))
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: hostChain('end') })
  mocks.close.mockResolvedValue(false)
  await applySessionFinishAction(session, arm({ ...action, action: 'end' }))
  expect(useSessionFolders.getState().metadata.finishActions?.session?.applied).not.toBe(true)
})

it('Me keeps verified work open in Done, without saving it to a folder or closing it', async () => {
  mocks.chain.mockReturnValue(hostChain('me'))
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: hostChain('me') })
  await applySessionFinishAction(session, arm({ ...action, action: 'me' }))
  expect(mocks.close).not.toHaveBeenCalled()
  expect(useSessionFolders.getState().metadata.membership).toEqual({})
  expect(useSessionFolders.getState().metadata.finishActions?.session).toMatchObject({
    action: 'me',
    applied: true,
    completedAt: expect.any(Number)
  })
})

it('defaults a newly configured session to Me', () => {
  expect(readSessionFinishAction(session).action).toBe('me')
})

it('Me returns a previously saved session to Done', async () => {
  mocks.chain.mockReturnValue(hostChain('me'))
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: hostChain('me') })
  useSessionFolders.getState().saveSession('session', SAVED_SESSIONS_FOLDER_ID)
  await applySessionFinishAction(session, arm({ ...action, action: 'me' }))
  expect(useSessionFolders.getState().metadata.membership).toEqual({})
  expect(useSessionFolders.getState().metadata.finishActions?.session?.applied).toBe(true)
  expect(mocks.close).not.toHaveBeenCalled()
  expect(records()).toEqual(['prepare move app/finish', 'applied move app/finish'])
})
it.each(['cached', 'verified'])(
  'rejects completion for another session in the %s chain',
  async (source) => {
    const other = { ...hostChain('end'), sourceRowKey: 'other-row' }
    if (source === 'cached') {
      mocks.chain.mockReturnValue(other)
    } else {
      mocks.chain.mockReturnValue(hostChain('end'))
      mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: other })
    }
    await applySessionFinishAction(session, arm({ ...action, action: 'end' }))
    expect(mocks.close).not.toHaveBeenCalled()
    expect(useSessionFolders.getState().metadata.finishActions?.session?.applied).not.toBe(true)
  }
)

it('adopts chat-scheduled host choices by source, owner and revision and keeps applied state', async () => {
  const chain = {
    id: 'chain',
    hostId: 'local',
    sourceRowKey: 'row',
    outcomeSet: {
      revision: 3,
      sessionFinish: { action: 'save' }
    }
  } as SessionChain
  adoptSessionFinishAction(session, chain)
  expect(readSessionFinishAction(session, chain)).toMatchObject({
    action: 'save',
    chainId: 'chain',
    revision: 3,
    executionOwnerKey: 'local'
  })
  mocks.chain.mockReturnValue(chain)
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain })
  await applySessionFinishAction(
    session,
    useSessionFolders.getState().metadata.finishActions!.session!
  )
  const applied = useSessionFolders.getState().metadata.finishActions!.session!
  adoptSessionFinishAction(session, chain)
  expect(useSessionFolders.getState().metadata.finishActions!.session).toBe(applied)
  expect(applied.applied).toBe(true)
  adoptSessionFinishAction(session, {
    ...chain,
    outcomeSet: { ...chain.outcomeSet!, revision: 2, sessionFinish: { action: 'end' } }
  })
  expect(useSessionFolders.getState().metadata.finishActions!.session).toBe(applied)
})

it('does not adopt another execution host or apply its completion despite colliding IDs', async () => {
  const wrongHost = {
    id: 'chain',
    hostId: 'runtime:other',
    sourceRowKey: 'row',
    outcomeSet: {
      revision: 3,
      sessionFinish: { action: 'end' }
    }
  } as SessionChain
  adoptSessionFinishAction(session, wrongHost)
  expect(useSessionFolders.getState().metadata.finishActions?.session).toBeUndefined()
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: wrongHost })
  mocks.chain.mockReturnValue({ ...wrongHost, hostId: 'local' })
  await applySessionFinishAction(
    session,
    arm({ ...action, action: 'end', executionOwnerKey: 'local' })
  )
  expect(mocks.close).not.toHaveBeenCalled()
})

it('closes nothing once the host no longer records a finish, whatever this device still mirrors', async () => {
  mocks.chain.mockReturnValue(hostChain(null))
  await applySessionFinishAction(session, arm({ ...action, action: 'end' }))
  expect(mocks.progress).not.toHaveBeenCalled()
  expect(mocks.close).not.toHaveBeenCalled()
  // The mirror of that very chain is stale, so nothing is shown as chosen either.
  expect(
    readSessionFinishAction(session, { ...hostChain(null), hostId: 'local' } as never)
  ).toEqual({
    action: 'me',
    folderId: SAVED_SESSIONS_FOLDER_ID
  })
})

it('closes nothing when the host records another finish than the one this device mirrors', async () => {
  mocks.chain.mockReturnValue(hostChain('save'))
  await applySessionFinishAction(session, arm({ ...action, action: 'end' }))
  expect(mocks.progress).not.toHaveBeenCalled()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(useSessionFolders.getState().metadata.membership).toEqual({})
})

it('lets the host’s finish replace a different device choice at the same revision', () => {
  arm({ ...action, action: 'end', executionOwnerKey: 'local' })
  const chain = { ...hostChain('save'), hostId: 'local' } as unknown as SessionChain
  adoptSessionFinishAction(session, chain)
  expect(useSessionFolders.getState().metadata.finishActions!.session).toMatchObject({
    action: 'save',
    chainId: 'chain',
    revision: 3,
    applied: false
  })
})

it('leaves a sealed run to the host’s disposition record, even with a complete legacy mirror', async () => {
  const sealed = {
    ...hostChain('end'),
    outcomeSet: { ...hostChain('end').outcomeSet, completion: {} }
  }
  mocks.chain.mockReturnValue(sealed)
  await applySessionFinishAction(session, arm({ ...action, action: 'end' }))
  expect(mocks.progress).not.toHaveBeenCalled()
  mocks.chain.mockReturnValue(hostChain('end'))
  mocks.progress.mockResolvedValue({ lifecycle: 'complete', chain: sealed })
  await applySessionFinishAction(session, arm({ ...action, action: 'end' }))
  expect(mocks.close).not.toHaveBeenCalled()
  expect(useSessionFolders.getState().metadata.finishActions?.session?.applied).not.toBe(true)
})
