import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AppChanges from './session-organization-app-changes'
import type { SidebarSession } from './sidebar-sessions'
import type { SessionChain } from '../../../shared/session-chain-types'
import type { SessionSidebarView } from './session-sidebar-view'
import { conversationPlanFixture } from './conversation-plan-fixture'
import {
  DONE_ARCHIVE_IDLE_REASON,
  doneArchiveEvidence,
  idleArchiveReceipt,
  type SessionDoneArchivePolicy
} from '../../../shared/session-done-archive'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  recorded: [] as unknown[],
  archive: vi.fn(() => true),
  restore: vi.fn(),
  sessions: [] as SidebarSession[],
  chain: null as SessionChain | null,
  policy: { revision: 'done', since: 1, delayMs: 1 } as SessionDoneArchivePolicy | null,
  scope: 'sal',
  saved: false,
  pinned: false,
  state: {
    workspaceSessionReady: true,
    agentStatusByPaneKey: {} as Record<
      string,
      { state: string; updatedAt?: number; failed?: boolean }
    >
  },
  view: {
    loaded: true,
    archiveStorageReady: true,
    archived: [] as string[],
    view: {
      version: 1,
      collapsed: [],
      hidden: [],
      order: [],
      autoArchiveKeep: []
    } as SessionSidebarView
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/store/pinned-tab-close-guard', () => ({ isUnifiedTabPinned: () => mocks.pinned }))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: {
    getState: () => ({ loaded: true, metadata: { folders: [], membership: {} } })
  }
}))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: {
    getState: () => ({ ...mocks.view, archiveVerified: mocks.archive, setArchived: mocks.restore })
  }
}))
vi.mock('./session-folders', () => ({ isSessionSaved: () => mocks.saved }))
vi.mock('./sidebar-sessions', () => ({ buildPaneSessions: () => mocks.sessions }))
vi.mock('./session-manage-sidebar-rows', () => ({
  buildSessionManageSidebarRows: () =>
    mocks.sessions.map((session) => ({
      ...session,
      doneArchivePolicy: mocks.policy
    }))
}))
vi.mock('./session-chain-registry', () => ({ findShownSessionChainForRow: () => mocks.chain }))
vi.mock('./session-finish-host-choice', () => ({ sessionOwnsOutcomeChain: () => true }))
vi.mock('./conversation-source-for-session', () => ({
  conversationSourceForSession: () => ({ paneKey: 'p', worktreeId: 'w' })
}))
vi.mock('./session-outcome-owner', () => ({ outcomeRuntimeTarget: () => ({ kind: 'local' }) }))
vi.mock('./account-sync/session-organization-intent', () => ({
  sessionOrganizationScope: () => mocks.scope
}))
vi.mock('../../../shared/session-archive-proof', () => ({
  sessionArchiveProof: () => 'proof',
  sessionCompletionIdentity: () => 'proof'
}))
vi.mock('@/components/next-action/up-next-client', () => ({ readUpNext: mocks.read }))
vi.mock('@/components/next-action/up-next-connection', () => ({
  upNextConnection: () => ({ assertCurrent: () => {} })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
// Why: the change path is proven on real stores elsewhere; here, which change and executor.
vi.mock('./session-organization-app-changes', async (importOriginal) => {
  const actual = await importOriginal<typeof AppChanges>()
  const { useSessionSidebarView } = await import('@/store/session-sidebar-view')
  const { useSessionFolders } = await import('@/store/session-folders')
  return {
    ...actual,
    applyRecordedChange: vi.fn(async (change: AppChanges.StoreActionChange) => {
      mocks.recorded.push(change.request)
      const stores = { folders: useSessionFolders, view: useSessionSidebarView } as never
      const error = change.act(change.request as never, stores)
      return error ? { ok: false, error } : { ok: true }
    })
  }
})
import { applyAutomaticSessionArchives } from './session-auto-archive'

let sequence = 0
beforeEach(() => {
  vi.clearAllMocks()
  mocks.recorded = []
  mocks.scope = 'sal'
  mocks.saved = mocks.pinned = false
  mocks.view = {
    loaded: true,
    archiveStorageReady: true,
    archived: [],
    view: {
      version: 1,
      collapsed: [],
      hidden: [],
      order: [],
      autoArchiveKeep: []
    } as SessionSidebarView
  }
  mocks.chain = conversationPlanFixture()
  mocks.policy = { revision: 'done', since: 1, delayMs: 1 }
  const id = `session-${++sequence}`
  mocks.sessions = [
    {
      rowKey: id,
      sessionKey: id,
      paneKey: id,
      tabId: id,
      worktreeId: 'w',
      hostId: 'local',
      label: 'Delivery',
      workspaceLabel: 'Work',
      agent: 'codex',
      kind: 'terminal',
      unavailable: false,
      folderKeyMigration: null
    }
  ]
  mocks.state = { workspaceSessionReady: true, agentStatusByPaneKey: { [id]: { state: 'done' } } }
  mocks.read.mockResolvedValue({ archiveProof: 'proof' })
})

it.each(['saved', 'pinned'] as const)('does not contact or archive a %s session', async (field) => {
  mocks[field] = true
  await applyAutomaticSessionArchives(100_000)
  expect(mocks.read).not.toHaveBeenCalled()
  expect(mocks.archive).not.toHaveBeenCalled()
})

it('does not contact or archive a session with no execution observation', async () => {
  mocks.state.agentStatusByPaneKey = {}
  await applyAutomaticSessionArchives(100_000)
  expect(mocks.read).not.toHaveBeenCalled()
  expect(mocks.archive).not.toHaveBeenCalled()
})

it('keeps old or offline hosts visible, and requires the exact proof', async () => {
  mocks.read.mockResolvedValue({ finishReady: true })
  await applyAutomaticSessionArchives(100_000)
  expect(mocks.archive).not.toHaveBeenCalled()
  mocks.read.mockRejectedValue(new Error('offline'))
  await applyAutomaticSessionArchives(140_000)
  expect(mocks.archive).not.toHaveBeenCalled()
  mocks.read.mockResolvedValue({ archiveProof: 'different run' })
  await applyAutomaticSessionArchives(180_000)
  expect(mocks.archive).not.toHaveBeenCalled()
})

it.each(['scope', 'activity', 'save', 'identity'] as const)(
  'rechecks %s after an asynchronous host read',
  async (change) => {
    mocks.read.mockImplementation(async () => {
      if (change === 'scope') {
        mocks.scope = 'someone-else'
      }
      if (change === 'activity') {
        mocks.state.agentStatusByPaneKey[mocks.sessions[0]!.paneKey!] = { state: 'working' }
      }
      if (change === 'save') {
        mocks.saved = true
      }
      if (change === 'identity') {
        mocks.sessions = []
      }
      return { archiveProof: 'proof' }
    })
    await applyAutomaticSessionArchives(100_000)
    expect(mocks.archive).not.toHaveBeenCalled()
  }
)

it('requires a single owner pane and writes the host proof for an eligible session', async () => {
  const session = mocks.sessions[0]!
  mocks.sessions.push({ ...session, rowKey: 'duplicate', paneKey: 'other' })
  await applyAutomaticSessionArchives(100_000)
  expect(mocks.archive).not.toHaveBeenCalled()
  mocks.sessions = [session]
  await applyAutomaticSessionArchives(140_000)
  expect(mocks.archive).toHaveBeenCalledWith(session.sessionKey, 'proof')
  expect(mocks.recorded).toEqual([
    {
      kind: 'archive',
      targets: [{ sessionKey: session.sessionKey }],
      value: true,
      executor: { kind: 'app', feature: 'auto-archive' },
      reason: 'Continuously Done with verified outcomes and no attention obligations',
      evidence: doneArchiveEvidence(session.sessionKey!, { revision: 'done', since: 1 })
    }
  ])
})

it('restores automatic archives when the host has queued work, without creating a keep override', async () => {
  const key = mocks.sessions[0]!.sessionKey!
  mocks.view.archived = [key]
  mocks.view.view.autoArchiveLog = [{ key, proof: 'proof', at: 1 }]
  mocks.read.mockResolvedValue({ finishReady: false, archiveHasWork: true })
  await applyAutomaticSessionArchives(100_000)
  expect(mocks.restore).toHaveBeenCalledWith([key], false, 'resume')
  expect(mocks.archive).not.toHaveBeenCalled()
  expect(mocks.recorded).toContainEqual({
    kind: 'unarchive',
    targets: [{ sessionKey: key }],
    value: false,
    executor: { kind: 'app', feature: 'auto-archive' }
  })
})

it('does not restore an automatic archive from another account after an in-flight read', async () => {
  const key = mocks.sessions[0]!.sessionKey!
  mocks.view.archived = [key]
  mocks.view.view.autoArchiveLog = [{ key, proof: 'proof', at: 1 }]
  mocks.read.mockImplementation(async () => {
    mocks.scope = 'another-account'
    return { finishReady: false, archiveHasWork: true }
  })
  await applyAutomaticSessionArchives(100_000)
  expect(mocks.restore).not.toHaveBeenCalled()
})

it.each([
  {},
  { finishReady: false },
  { archiveProof: 'another process incarnation', archiveHasWork: false }
])(
  'retains automatic archives when the host has no positive new-work evidence: %j',
  async (reading) => {
    const key = mocks.sessions[0]!.sessionKey!
    mocks.view.archived = [key]
    mocks.view.view.autoArchiveLog = [{ key, proof: 'proof', at: 1 }]
    mocks.read.mockResolvedValue(reading)
    await applyAutomaticSessionArchives(100_000)
    expect(mocks.restore).not.toHaveBeenCalled()
  }
)

describe('an everyday conversation with no plan', () => {
  const HOUR2 = 120 * 60_000
  beforeEach(() => {
    mocks.chain = null
    mocks.policy = { revision: 'done', since: 1, delayMs: HOUR2 }
    mocks.read.mockResolvedValue({
      finishReady: true,
      archiveHasWork: false,
      idleArchiveClear: true
    })
  })

  it('is archived once continuously Done for the delay, and not a minute before', async () => {
    const session = mocks.sessions[0]!
    await applyAutomaticSessionArchives(1 + HOUR2 - 60_000)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.archive).not.toHaveBeenCalled()
    await applyAutomaticSessionArchives(1 + HOUR2 + 60_000)
    const receipt = idleArchiveReceipt(session.sessionKey!, mocks.policy!)
    expect(mocks.archive).toHaveBeenCalledWith(session.sessionKey, receipt)
    expect(mocks.recorded).toEqual([
      expect.objectContaining({
        kind: 'archive',
        executor: { kind: 'app', feature: 'auto-archive' },
        reason: DONE_ARCHIVE_IDLE_REASON,
        evidence: doneArchiveEvidence(session.sessionKey!, mocks.policy!)
      })
    ])
    expect((mocks.recorded[0] as { evidence: string }).evidence.length).toBeLessThan(100)
  })

  // Waiting-for-yes, an ask, a queue, a held prompt, Keep going or a waiter: the host says so.
  it.each([
    { finishReady: true, archiveHasWork: false, idleArchiveClear: false },
    { finishReady: true, archiveHasWork: false },
    { finishReady: false, archiveHasWork: true, idleArchiveClear: false }
  ])('stays when its host does not read it idle with nothing pending: %j', async (reading) => {
    mocks.read.mockResolvedValue(reading)
    await applyAutomaticSessionArchives(1 + HOUR2 + 60_000)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('stays without a Done clock (unread bell, attention, snooze, unverifiable activity)', async () => {
    mocks.policy = null
    await applyAutomaticSessionArchives(1 + HOUR2 + 60_000)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it.each([
    ['no state report', null],
    ['working', { state: 'working' }],
    ['waiting', { state: 'waiting' }],
    ['failed', { state: 'done', failed: true }]
  ])('stays with %s', async (_name, status) => {
    const pane = mocks.sessions[0]!.paneKey!
    mocks.state.agentStatusByPaneKey = status ? { [pane]: status } : {}
    await applyAutomaticSessionArchives(1 + HOUR2 + 60_000)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('stays when it runs on another computer', async () => {
    mocks.sessions[0]!.hostId = 'ssh:box'
    await applyAutomaticSessionArchives(1 + HOUR2 + 60_000)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('never lets a planned conversation through on the idle reading', async () => {
    mocks.chain = conversationPlanFixture()
    mocks.read.mockResolvedValue({
      finishReady: true,
      archiveHasWork: false,
      idleArchiveClear: true
    })
    await applyAutomaticSessionArchives(1 + HOUR2 + 60_000)
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('comes back on any later status report', async () => {
    const session = mocks.sessions[0]!
    const key = session.sessionKey!
    mocks.view.archived = [key]
    mocks.view.view.autoArchiveLog = [
      { key, proof: idleArchiveReceipt(key, mocks.policy!), at: 5_000 }
    ]
    mocks.state.agentStatusByPaneKey[session.paneKey!] = { state: 'done', updatedAt: 4_000 }
    await applyAutomaticSessionArchives(10_000)
    expect(mocks.restore).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    mocks.state.agentStatusByPaneKey[session.paneKey!] = { state: 'done', updatedAt: 6_000 }
    await applyAutomaticSessionArchives(50_000)
    expect(mocks.restore).toHaveBeenCalledWith([key], false, 'resume')
  })
})
