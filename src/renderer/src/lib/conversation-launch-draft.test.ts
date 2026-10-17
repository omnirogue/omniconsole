import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LaunchAgentInNewTabArgs,
  LaunchAgentInNewTabResult
} from './launch-agent-in-new-tab-types'
import {
  CONVERSATION_LAUNCH_VERIFICATION_TIMEOUT_MS,
  reserveConversationLaunch,
  updateConversationLaunchDraft,
  useConversationLaunchDrafts
} from './conversation-launch-draft'

type PendingTab = { id: string; conversationLaunchPending?: boolean }
type VerifiedLaunch = Pick<
  LaunchAgentInNewTabArgs,
  'agent' | 'launchPreferences' | 'launchEnv' | 'conversationLauncher'
>
const mocks = vi.hoisted(() => ({
  launch: vi.fn<(args: LaunchAgentInNewTabArgs) => LaunchAgentInNewTabResult>(),
  uuid: vi.fn()
}))
const listeners = new Set<() => void>()
function publish(): void {
  for (const listener of listeners) {
    listener()
  }
}
const store = {
  owners: {} as Record<string, string | undefined>,
  paths: {} as Record<string, string>,
  tabsByWorktree: {} as Record<string, PendingTab[]>,
  unifiedTabsByWorktree: {} as Record<string, { entityId: string; groupId: string }[]>,
  groupsByWorktree: {} as Record<string, { id: string }[]>,
  activeGroupIdByWorktree: {} as Record<string, string>,
  activeTabIdByWorktree: {} as Record<string, string>,
  activeWorktreeId: 'wt-1',
  getKnownWorktreeById: (id: string) =>
    store.paths[id] ? { id, path: store.paths[id] } : undefined,
  createTab: vi.fn(
    (worktreeId: string, groupId: string | undefined, _unused: unknown, tab: PendingTab) => {
      store.tabsByWorktree[worktreeId] = [...(store.tabsByWorktree[worktreeId] ?? []), tab]
      store.unifiedTabsByWorktree[worktreeId] = [
        ...(store.unifiedTabsByWorktree[worktreeId] ?? []),
        { entityId: tab.id, groupId: groupId ?? store.activeGroupIdByWorktree[worktreeId] }
      ]
      store.activeTabIdByWorktree[worktreeId] = tab.id
      publish()
      return tab
    }
  ),
  closeTab: vi.fn((tabId: string, _options?: unknown) => {
    for (const worktreeId of Object.keys(store.tabsByWorktree)) {
      store.tabsByWorktree[worktreeId] = store.tabsByWorktree[worktreeId].filter(
        (tab) => tab.id !== tabId
      )
    }
    publish()
  }),
  setTabCustomTitle: vi.fn(),
  setActiveTabType: vi.fn(),
  setActiveView: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => store,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: mocks.uuid }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  getAgentDetectionTargetKeyForWorktree: (state: typeof store, worktreeId: string) =>
    state.owners[worktreeId]
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function reserve(overrides: Partial<Parameters<typeof reserveConversationLaunch>[0]> = {}): {
  tabId: string
  verification: ReturnType<typeof deferred<VerifiedLaunch>>
} {
  const verification = deferred<VerifiedLaunch>()
  const tabId = reserveConversationLaunch({
    worktreeId: 'wt-1',
    verify: () => verification.promise,
    scopeIsCurrent: () => true,
    viewModePreference: 'chat',
    ...overrides
  })
  return { tabId, verification }
}

function launchResult(tabId: string | null): NonNullable<LaunchAgentInNewTabResult> {
  return {
    tabId,
    pasteDraftAfterLaunch: false,
    startupPlan: {
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  let sequence = 0
  mocks.uuid.mockImplementation(() => `draft-${++sequence}`)
  mocks.launch.mockImplementation((args) => {
    const tab = store.tabsByWorktree[args.worktreeId].find((entry) => entry.id === args.tabId)
    if (tab) {
      delete tab.conversationLaunchPending
    }
    publish()
    return launchResult(args.tabId ?? null)
  })
  store.owners = { 'wt-1': 'runtime:host-1', 'wt-2': 'ssh:host-2' }
  store.paths = { 'wt-1': '/project/one', 'wt-2': '/project/two' }
  store.tabsByWorktree = {}
  store.unifiedTabsByWorktree = {}
  store.groupsByWorktree = {
    'wt-1': [{ id: 'group-1' }, { id: 'group-2' }],
    'wt-2': [{ id: 'group-3' }]
  }
  store.activeGroupIdByWorktree = { 'wt-1': 'group-1', 'wt-2': 'group-3' }
  store.activeTabIdByWorktree = {}
  store.activeWorktreeId = 'wt-1'
  useConversationLaunchDrafts.setState({ drafts: {} })
})

afterEach(() => {
  store.tabsByWorktree = {}
  publish()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('reserveConversationLaunch', () => {
  it('preserves explicit account and launcher intent after verification', async () => {
    const { verification } = reserve()
    verification.resolve({
      agent: 'claude',
      launchEnv: { CLAUDE_CONFIG_DIR: '/owned/account' },
      conversationLauncher: true
    })
    await vi.runAllTimersAsync()
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        launchEnv: { CLAUDE_CONFIG_DIR: '/owned/account' },
        conversationLauncher: true
      })
    )
  })
  it('publishes and selects an editable pending tab before verification settles', () => {
    const verification = deferred<VerifiedLaunch>()
    const observeVerificationStart = vi.fn()
    const verify = vi.fn(() => {
      observeVerificationStart(
        store.activeTabIdByWorktree['wt-1'],
        useConversationLaunchDrafts.getState().drafts['draft-1']
      )
      return verification.promise
    })
    const { tabId } = reserve({ verify })

    expect(verify).toHaveBeenCalledTimes(1)
    expect(observeVerificationStart).toHaveBeenCalledWith(tabId, { text: '', status: 'checking' })
    expect(store.tabsByWorktree['wt-1']).toEqual([{ id: tabId, conversationLaunchPending: true }])
    expect(store.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(store.setActiveView).toHaveBeenCalledWith('terminal')
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('keeps concurrent drafts independent when their verifications finish out of order', async () => {
    const first = reserve()
    const second = reserve()
    updateConversationLaunchDraft(first.tabId, { text: 'Review the release' })
    updateConversationLaunchDraft(second.tabId, { text: 'Write the handoff' })

    second.verification.resolve({ agent: 'claude' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    expect(mocks.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabId: second.tabId,
        agent: 'claude',
        prompt: 'Write the handoff'
      })
    )
    expect(useConversationLaunchDrafts.getState().drafts[first.tabId]).toEqual({
      text: 'Review the release',
      status: 'checking'
    })

    first.verification.resolve({ agent: 'codex' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabId: first.tabId,
        agent: 'codex',
        prompt: 'Review the release'
      })
    )
    expect(useConversationLaunchDrafts.getState().drafts).toEqual({})
  })

  it('cancels a closed draft before discovery finishes', async () => {
    const { tabId, verification } = reserve()
    store.closeTab(tabId)
    expect(useConversationLaunchDrafts.getState().drafts[tabId]).toBeUndefined()

    verification.resolve({ agent: 'codex' })
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.launch).not.toHaveBeenCalled()
    expect(store.tabsByWorktree['wt-1']).toEqual([])
  })

  it('retains the request and a readable verification error in the pending tab', async () => {
    const { tabId, verification } = reserve()
    updateConversationLaunchDraft(tabId, { text: 'Keep this request' })
    verification.reject(new Error('The execution host is offline'))
    await vi.advanceTimersByTimeAsync(0)

    expect(useConversationLaunchDrafts.getState().drafts[tabId]).toEqual({
      text: 'Keep this request',
      status: 'failed',
      error: 'The execution host is offline'
    })
    expect(store.tabsByWorktree['wt-1'][0].conversationLaunchPending).toBe(true)
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('forwards the latest request as an editable draft to the original group after navigation', async () => {
    const { tabId, verification } = reserve({ viewModePreference: 'terminal' })
    updateConversationLaunchDraft(tabId, { text: 'First idea' })
    store.activeWorktreeId = 'wt-2'
    store.activeGroupIdByWorktree['wt-1'] = 'group-2'
    updateConversationLaunchDraft(tabId, { text: '  Review the release\nand prepare a handoff  ' })
    verification.resolve({ agent: 'codex', launchPreferences: null })
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.launch).toHaveBeenCalledWith({
      agent: 'codex',
      launchPreferences: null,
      worktreeId: 'wt-1',
      groupId: 'group-1',
      tabId,
      reservedConversationTabId: tabId,
      launchSource: 'sidebar',
      viewModePreference: 'terminal',
      promptDelivery: 'draft',
      prompt: '  Review the release\nand prepare a handoff  '
    })
  })

  it.each(['runtime owner', 'account scope', 'worktree path', 'removed group'])(
    'refuses a launch after its %s changes',
    async (change) => {
      let scopeIsCurrent = true
      const { tabId, verification } = reserve({ scopeIsCurrent: () => scopeIsCurrent })
      if (change === 'runtime owner') {
        store.owners['wt-1'] = 'runtime:other-host'
      }
      if (change === 'account scope') {
        scopeIsCurrent = false
      }
      if (change === 'worktree path') {
        store.paths['wt-1'] = '/different/project'
      }
      if (change === 'removed group') {
        store.groupsByWorktree['wt-1'] = [{ id: 'group-2' }]
      }
      verification.resolve({ agent: 'codex' })
      await vi.advanceTimersByTimeAsync(0)

      expect(mocks.launch).not.toHaveBeenCalled()
      expect(useConversationLaunchDrafts.getState().drafts[tabId]).toEqual({
        text: '',
        status: 'failed',
        error: expect.stringContaining('work location or account changed')
      })
    }
  )

  it('keeps a structured launch visible until host publication succeeds', async () => {
    const completion = deferred<boolean>()
    mocks.launch.mockReturnValue({ ...launchResult(null), launchCompletion: completion.promise })
    const { tabId, verification } = reserve()
    verification.resolve({ agent: 'codex' })
    await vi.advanceTimersByTimeAsync(0)

    expect(useConversationLaunchDrafts.getState().drafts[tabId]?.status).toBe('launching')
    expect(store.tabsByWorktree['wt-1'][0].conversationLaunchPending).toBe(true)
    expect(store.closeTab).not.toHaveBeenCalled()

    completion.resolve(true)
    await vi.advanceTimersByTimeAsync(0)

    expect(store.closeTab).toHaveBeenCalledWith(tabId, {
      reason: 'cleanup',
      captureRecentlyClosed: false
    })
    expect(useConversationLaunchDrafts.getState().drafts[tabId]).toBeUndefined()
  })

  it.each(['refused', 'rejected'])(
    'keeps the draft and error when structured publication is %s',
    async (outcome) => {
      const completion = deferred<boolean>()
      mocks.launch.mockReturnValue({ ...launchResult(null), launchCompletion: completion.promise })
      const { tabId, verification } = reserve()
      updateConversationLaunchDraft(tabId, { text: 'Preserve my request' })
      verification.resolve({ agent: 'codex' })
      await vi.advanceTimersByTimeAsync(0)
      if (outcome === 'refused') {
        completion.resolve(false)
      } else {
        completion.reject(new Error('Host publication failed'))
      }
      await vi.advanceTimersByTimeAsync(0)

      expect(useConversationLaunchDrafts.getState().drafts[tabId]).toEqual({
        text: 'Preserve my request',
        status: 'failed',
        error: expect.any(String)
      })
      expect(store.closeTab).not.toHaveBeenCalled()
      expect(store.tabsByWorktree['wt-1'][0].conversationLaunchPending).toBe(true)
    }
  )

  it('reports a start for one-shot launcher context, and never for a refused launch', async () => {
    const onStarted = vi.fn()
    reserve({ onStarted }).verification.resolve({ agent: 'codex' })
    await vi.advanceTimersByTimeAsync(0)
    expect(onStarted).toHaveBeenCalledTimes(1)

    const refusedTab = vi.fn()
    mocks.launch.mockImplementationOnce((args) => ({
      ...launchResult(args.tabId ?? null),
      launchCompletion: Promise.resolve(false)
    }))
    reserve({ onStarted: refusedTab }).verification.resolve({ agent: 'codex' })
    await vi.advanceTimersByTimeAsync(0)
    expect(refusedTab).not.toHaveBeenCalled()

    const refusedHost = vi.fn()
    mocks.launch.mockReturnValueOnce({
      ...launchResult(null),
      launchCompletion: Promise.resolve(false)
    })
    reserve({ onStarted: refusedHost }).verification.resolve({ agent: 'codex' })
    await vi.advanceTimersByTimeAsync(0)
    expect(refusedHost).not.toHaveBeenCalled()
  })

  it('retains a timed-out request and never launches from a late verification reply', async () => {
    const { tabId, verification } = reserve()
    updateConversationLaunchDraft(tabId, { text: 'Do not lose this request' })
    await vi.advanceTimersByTimeAsync(CONVERSATION_LAUNCH_VERIFICATION_TIMEOUT_MS - 1)
    expect(useConversationLaunchDrafts.getState().drafts[tabId]?.status).toBe('checking')

    await vi.advanceTimersByTimeAsync(1)

    expect(useConversationLaunchDrafts.getState().drafts[tabId]).toEqual({
      text: 'Do not lose this request',
      status: 'failed',
      error: expect.stringContaining('could not be verified in time')
    })
    verification.resolve({ agent: 'codex' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(store.tabsByWorktree['wt-1'][0].conversationLaunchPending).toBe(true)
  })
})
