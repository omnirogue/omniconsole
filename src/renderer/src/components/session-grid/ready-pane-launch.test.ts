/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { reserveConversationLaunch } from '@/lib/conversation-launch-draft'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  useReadyPaneDrafts,
  updateReadyPane,
  updateReadySubmission
} from '@/store/ready-pane-drafts'
import {
  findReadySubmissionSession,
  sendReadyPane,
  reconcileReadyPane,
  recoverReadyPaneLaunches
} from './ready-pane-launch'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  reserve: vi.fn(),
  appListeners: new Set<() => void>(),
  gridListeners: new Set<() => void>(),
  scope: 'scope',
  sessions: [] as SidebarSession[],
  grid: {
    commandCenter: true,
    panes: {} as Record<string, unknown>,
    layout: { tracks: [] as string[][] },
    focusedPaneId: null as string | null,
    replacePane: vi.fn(),
    restorePane: vi.fn(),
    movePane: vi.fn(),
    addPane: vi.fn()
  }
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ scope: mocks.scope, settings: {} }),
    subscribe: (fn: () => void) => {
      mocks.appListeners.add(fn)
      return () => mocks.appListeners.delete(fn)
    }
  }
}))
vi.mock('@/store/session-grid', () => ({
  useSessionGrid: {
    getState: () => mocks.grid,
    subscribe: (fn: () => void) => {
      mocks.gridListeners.add(fn)
      return () => mocks.gridListeners.delete(fn)
    }
  }
}))
vi.mock('@/lib/console-account-scope', () => ({ selectConsoleAccountScope: () => mocks.scope }))
vi.mock('@/lib/sidebar-sessions', () => ({ buildPaneSessions: () => mocks.sessions }))
vi.mock('./prepare-ready-pane-launch', () => ({ prepareReadyPaneLaunch: mocks.prepare }))
vi.mock('@/lib/conversation-launch-draft', () => ({
  reserveConversationLaunch: mocks.reserve,
  verifyConversationLaunch: (fn: () => unknown) => fn()
}))
vi.mock('../sidebar/session-folders/new-conversation/launch-context', () => ({
  launcherViewModePreference: () => 'chat'
}))
let counter = 0
let paneId: string
const draft = { text: 'Do the task', model: 'sonnet', effort: 'high', account: 'managed:a' }
const read = () => useReadyPaneDrafts.getState().documents.scope.panes[paneId]
const request = () =>
  mocks.reserve.mock.calls[0][0] as Parameters<typeof reserveConversationLaunch>[0]
const session = (tabId: string, hostId = 'runtime:host') =>
  ({
    tabId,
    hostId,
    worktreeId: 'wt',
    sessionKey: 'conversation',
    paneKey: 'pane',
    label: 'Task',
    launchPending: false,
    unavailable: false
  }) as SidebarSession
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  useReadyPaneDrafts.setState({ documents: {}, errors: {} })
  mocks.appListeners.clear()
  mocks.gridListeners.clear()
  mocks.scope = 'scope'
  mocks.sessions = []
  paneId = `ready-${++counter}`
  mocks.grid.panes = { [paneId]: { kind: 'view', viewId: 'ready', id: paneId } }
  mocks.grid.layout = { tracks: [[paneId]] }
  mocks.grid.focusedPaneId = paneId
  mocks.grid.restorePane.mockReturnValue({ status: 'full', paneId: null })
  mocks.grid.addPane.mockImplementation(() => {
    mocks.grid.focusedPaneId = 'session-pane'
    return { status: 'added', paneId: 'session-pane' }
  })
  mocks.grid.replacePane.mockImplementation(() => {
    mocks.grid.focusedPaneId = 'session-pane'
  })
  mocks.prepare.mockReset().mockResolvedValue({
    worktreeId: 'wt',
    hostId: 'runtime:host',
    agent: 'claude',
    launchEnv: { CLAUDE_CONFIG_DIR: '/host/account' },
    launchPreferences: { model: 'sonnet', effort: 'high' }
  })
  updateReadyPane('scope', paneId, (pane) => ({
    ...pane,
    workspace: 'wt',
    drafts: { claude: draft, codex: { text: 'Other provider' } }
  }))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('one ready-pane submission', () => {
  it('makes no discovery, reservation or timer while loading a draft', () => {
    recoverReadyPaneLaunches('scope')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.reserve).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(mocks.appListeners.size).toBe(0)
  })
  it('ignores a second Send during validation and preserves the submission id through reservation', async () => {
    let resolve!: (value: unknown) => void
    mocks.prepare.mockReturnValueOnce(
      new Promise((accept) => {
        resolve = accept
      })
    )
    const sending = sendReadyPane('scope', paneId, draft)
    const id = read().submission?.id
    await sendReadyPane('scope', paneId, draft)
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.reserve).not.toHaveBeenCalled()
    resolve({ worktreeId: 'wt', hostId: 'runtime:host', agent: 'claude' })
    await sending
    expect(request()).toMatchObject({
      navigate: false,
      submissionId: id,
      worktreeId: 'wt',
      viewModePreference: 'chat'
    })
    await sendReadyPane('scope', paneId, draft)
    expect(mocks.reserve).toHaveBeenCalledOnce()
  })
  it('keeps the draft on a validation failure and allows a fresh Retry', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('host disconnected'))
    await sendReadyPane('scope', paneId, draft)
    expect(read().submission).toMatchObject({ status: 'failed', error: 'host disconnected' })
    expect(read().drafts.claude.text).toBe(draft.text)
    expect(mocks.reserve).not.toHaveBeenCalled()
    const failedId = read().submission?.id
    await sendReadyPane('scope', paneId, draft)
    expect(read().submission?.id).not.toBe(failedId)
    expect(mocks.reserve).toHaveBeenCalledOnce()
  })
  it.each(['publication-first', 'delivery-first'])(
    'binds on publication and clears only after delivery (%s)',
    async (order) => {
      await sendReadyPane('scope', paneId, draft)
      const verified = await request().verify()
      verified.onSessionCreated?.('created-tab')
      if (order === 'publication-first') {
        mocks.sessions = [session('created-tab')]
      } else {
        verified.onPromptDelivered?.()
      }
      reconcileReadyPane('scope', paneId)
      expect(mocks.grid.replacePane).toHaveBeenCalledTimes(order === 'publication-first' ? 1 : 0)
      if (order === 'publication-first') {
        expect(read().submission?.status).toBe('attached')
        await sendReadyPane('scope', paneId, draft)
        expect(mocks.reserve).toHaveBeenCalledOnce()
      }
      expect(read().drafts.claude.text).toBe(draft.text)
      if (order === 'publication-first') {
        verified.onPromptDelivered?.()
      } else {
        mocks.sessions = [session('created-tab')]
        reconcileReadyPane('scope', paneId)
      }
      expect(mocks.grid.replacePane).toHaveBeenCalledOnce()
      expect(mocks.grid.replacePane.mock.calls[0][1]).toMatchObject({
        kind: 'session',
        executionHostId: 'runtime:host',
        tabId: 'created-tab',
        worktreeId: 'wt'
      })
      expect(read().drafts.claude.text).toBe('')
      expect(read().drafts.codex.text).toBe('Other provider')
      expect(useReadyPaneDrafts.getState().documents.scope.traces[0].timings).toEqual(
        expect.objectContaining({
          submitted: expect.any(Number),
          validated: expect.any(Number),
          published: expect.any(Number),
          delivered: expect.any(Number),
          attached: expect.any(Number)
        })
      )
    }
  )
  it('restores a fresh ready pane to its old slot when room exists', async () => {
    mocks.grid.restorePane.mockReturnValue({ status: 'added', paneId })
    await sendReadyPane('scope', paneId, draft)
    const verified = await request().verify()
    verified.onSessionCreated?.('created-tab')
    mocks.sessions = [session('created-tab')]
    verified.onPromptDelivered?.()
    expect(mocks.grid.restorePane).toHaveBeenCalledWith(paneId)
    expect(mocks.grid.movePane).toHaveBeenCalledWith(paneId, {
      paneId: 'session-pane',
      zone: 'center'
    })
  })
  it('keeps the fresh ready pane in the tray when that setting is selected', async () => {
    updateReadyPane('scope', paneId, (pane) => ({ ...pane, fresh: 'tray' }))
    await sendReadyPane('scope', paneId, draft)
    const verified = await request().verify()
    verified.onSessionCreated?.('created-tab')
    mocks.sessions = [session('created-tab')]
    verified.onPromptDelivered?.()
    expect(mocks.grid.restorePane).not.toHaveBeenCalled()
  })
  it('will not clear a delivered draft when its ready pane is hidden and the grid is full', async () => {
    await sendReadyPane('scope', paneId, draft)
    const verified = await request().verify()
    verified.onSessionCreated?.('created-tab')
    mocks.sessions = [session('created-tab')]
    mocks.grid.layout.tracks = [Array.from({ length: 8 }, (_, i) => `other-${i}`)]
    verified.onPromptDelivered?.()
    expect(read().drafts.claude.text).toBe(draft.text)
    expect(mocks.grid.addPane).not.toHaveBeenCalled()
    mocks.grid.layout.tracks = [['other']]
    reconcileReadyPane('scope', paneId)
    expect(mocks.grid.addPane).toHaveBeenCalledOnce()
    expect(read().drafts.claude.text).toBe('')
  })
  it('retains uncertain submissions after timeout and never offers a duplicate Send', async () => {
    await sendReadyPane('scope', paneId, draft)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read().submission?.status).toBe('uncertain')
    await sendReadyPane('scope', paneId, draft)
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.reserve).toHaveBeenCalledOnce()
    expect(read().drafts.claude.text).toBe(draft.text)
  })
  it('distinguishes a definitive host refusal from an unconfirmed create', async () => {
    await sendReadyPane('scope', paneId, draft)
    request().onLaunchResult?.({
      tabId: null,
      startupPlan: {} as never,
      pasteDraftAfterLaunch: false,
      launchOutcome: Promise.resolve('failed')
    })
    await flush()
    expect(read().submission?.status).toBe('failed')
    await sendReadyPane('scope', paneId, draft)
    const next = mocks.reserve.mock.calls[1][0] as Parameters<typeof reserveConversationLaunch>[0]
    next.onError?.(new Error('transport lost'), true)
    expect(read().submission?.status).toBe('uncertain')
    await sendReadyPane('scope', paneId, draft)
    expect(mocks.reserve).toHaveBeenCalledTimes(2)
  })
  it('refuses to launch if the account changes during validation', async () => {
    mocks.prepare.mockImplementationOnce(async () => {
      mocks.scope = 'other'
      return { worktreeId: 'wt', hostId: 'runtime:host', agent: 'claude' }
    })
    await sendReadyPane('scope', paneId, draft)
    expect(read().submission?.status).toBe('failed')
    expect(mocks.reserve).not.toHaveBeenCalled()
  })
  it('matches publication by host, workspace and exact tab identity', () => {
    const submission = {
      id: 'submission',
      status: 'uncertain' as const,
      provider: 'claude' as const,
      tabId: 'tab',
      hostId: 'runtime:host',
      worktreeId: 'wt',
      timings: { submitted: 1 }
    }
    expect(findReadySubmissionSession(submission, [session('tab', 'local')])).toBeUndefined()
    expect(
      findReadySubmissionSession(submission, [{ ...session('tab'), worktreeId: 'other' }])
    ).toBeUndefined()
    expect(
      findReadySubmissionSession(submission, [{ ...session('tab'), launchPending: true }])
    ).toBeUndefined()
    expect(findReadySubmissionSession(submission, [session('tab')])).toBeDefined()
  })
  it('reconciles a late pushed session without launching again', async () => {
    await sendReadyPane('scope', paneId, draft)
    const id = read().submission!.id
    updateReadySubmission('scope', paneId, id, {
      status: 'uncertain',
      tabId: 'late-tab',
      delivered: true
    })
    mocks.sessions = [session('late-tab')]
    for (const listener of mocks.appListeners) {
      listener()
    }
    expect(mocks.grid.replacePane).toHaveBeenCalledOnce()
    expect(mocks.reserve).toHaveBeenCalledOnce()
  })
})
