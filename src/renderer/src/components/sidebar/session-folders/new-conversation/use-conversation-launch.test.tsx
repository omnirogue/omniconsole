/** @vitest-environment happy-dom */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as ConversationLaunchDraftModule from '@/lib/conversation-launch-draft'
import { useConversationLaunch } from './use-conversation-launch'
import type { LauncherCapability } from './resolve-launch-plan'
import { emptyLaunchManifest } from '../../../../../../shared/launch-manifest'
import { pickFromLaunchManifest } from './launch-context'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  customLaunch: vi.fn(),
  reserve: vi.fn(),
  company: vi.fn(),
  error: vi.fn(),
  activateAndReveal: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  consume: vi.fn(),
  state: {
    settings: {},
    rateLimits: {},
    activeGroupIdByWorktree: {},
    groupsByWorktree: {}
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launch
}))
vi.mock('@/lib/launch-custom-model', () => ({ launchCustomModel: mocks.customLaunch }))
vi.mock('@/lib/launch-session-context', () => ({ consumeLaunchSessionContext: mocks.consume }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndReveal
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/lib/start-company-session', () => ({
  startCompanySession: mocks.company,
  createCompanySessionFolder: vi.fn()
}))
vi.mock('@/lib/conversation-launch-draft', async (importOriginal) => ({
  ...(await importOriginal<typeof ConversationLaunchDraftModule>()),
  reserveConversationLaunch: mocks.reserve
}))
vi.mock('@/lib/console-account-scope', () => ({
  selectConsoleAccountScope: () => 'local'
}))
vi.mock('./launcher-target', () => ({
  rememberLauncherCompany: vi.fn(),
  openLauncherAccounts: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: vi.fn() } }))
const capabilities: LauncherCapability[] = [
  { id: 'claude', label: 'Claude', status: 'usable', models: [] }
]
const input = () => ({
  worktreeId: 'worktree',
  scope: 'local',
  local: true,
  rows: { claude: [], codex: [] },
  readCapabilities: () => capabilities,
  setOpen: vi.fn()
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.state.settings = {}
  mocks.launch.mockReturnValue({ tabId: 'new' })
  mocks.company.mockResolvedValue({ ok: true, workspaceId: 'company' })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('refreshes custom model availability and never substitutes the ordinary launcher', async () => {
  const models: LauncherCapability[] = [
    {
      id: 'omp',
      label: 'OMP',
      status: 'usable',
      models: [
        {
          id: 'openrouter/stealth/ox-alpha',
          label: 'Ox Alpha',
          options: [],
          openrouterRouting: 'omp-openrouter-routing-v1'
        }
      ]
    }
  ]
  const refreshCapabilities = vi.fn().mockResolvedValue(models)
  mocks.customLaunch.mockResolvedValue('custom-tab')
  const onLaunched = vi.fn()
  const { result } = renderHook(() =>
    useConversationLaunch({
      ...input(),
      readCapabilities: () => models,
      refreshCapabilities,
      onLaunched
    })
  )
  await act(async () => {
    void result.current.start({ customModelId: 'stealth/ox-alpha' })
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(refreshCapabilities).toHaveBeenCalledOnce()
  expect(mocks.customLaunch).toHaveBeenCalledWith({
    worktreeId: 'worktree',
    modelId: 'stealth/ox-alpha',
    viewMode: 'terminal',
    prompt: undefined,
    onSessionCreated: expect.any(Function)
  })
  expect(onLaunched).toHaveBeenCalledWith('custom-tab')
  expect(mocks.launch).not.toHaveBeenCalled()
})

it('keeps an unavailable custom model visible as an error without starting any agent', async () => {
  const { result } = renderHook(() => useConversationLaunch(input()))
  await act(async () => {
    void result.current.start({ customModelId: 'stealth/ox-alpha' })
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(result.current.launchError).toContain('stealth/ox-alpha')
  expect(mocks.customLaunch).not.toHaveBeenCalled()
  expect(mocks.launch).not.toHaveBeenCalled()
})

it.each([
  { company: false, chat: true },
  { company: false, chat: false },
  { company: true, chat: true },
  { company: true, chat: false }
])(
  'launches with the saved Chat View choice (company=$company, chat=$chat)',
  async ({ company, chat }) => {
    mocks.state.settings = {
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: chat
    }
    const { result } = renderHook(() =>
      useConversationLaunch({
        ...input(),
        ...(company ? { worktreeId: null, company: { name: 'OmniRogue' } } : {})
      })
    )
    await act(async () => {
      void result.current.start()
      await vi.advanceTimersByTimeAsync(301)
    })
    expect(company ? mocks.company : mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        viewModePreference: chat ? 'chat' : 'terminal'
      })
    )
  }
)

// Why (measured live on c39b7cf81): launching from the sidebar "+" left a new
// tab in the sidebar list while the main view stayed on Work home — the same
// reveal path a sidebar session-row click uses must run for this launch too.
it('reveals and focuses the launched conversation the same way a sidebar row click would', async () => {
  const { result } = renderHook(() => useConversationLaunch(input()))
  // Why not await start(): it holds the double-click guard on a 300 ms timer, which
  // fake timers only release when advanced.
  await act(async () => {
    void result.current.start()
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(mocks.activateAndReveal).toHaveBeenCalledWith('worktree', {
    providesInitialSurface: true
  })
  expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('new', null, {
    flashFocusedPane: true
  })
})

it('holds the guard beyond a synchronous launch and releases it for later clicks', async () => {
  const { result } = renderHook(() => useConversationLaunch(input()))
  act(() => {
    void result.current.start()
    void result.current.start()
  })
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  act(() => {
    void result.current.start()
  })
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(101)
  })
  act(() => {
    void result.current.start()
  })
  expect(mocks.launch).toHaveBeenCalledTimes(2)
})

it('guards the entire reservation until completion and the double-click interval', async () => {
  const { result } = renderHook(() =>
    useConversationLaunch({
      ...input(),
      loading: true,
      readCapabilities: () => [],
      refreshCapabilities: async () => capabilities
    })
  )
  act(() => {
    void result.current.start()
    void result.current.start()
  })
  expect(mocks.reserve).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  act(() => {
    void result.current.start()
  })
  expect(mocks.reserve).toHaveBeenCalledTimes(1)
  await act(async () => {
    mocks.reserve.mock.calls[0][0].onSettled()
  })
  act(() => {
    void result.current.start()
  })
  expect(mocks.reserve).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(result.current.starting).toBe(false)
})

it('waits for cold-start company detection without reporting an unavailable agent', async () => {
  let finish!: (value: LauncherCapability[]) => void
  const refreshCapabilities = vi.fn(
    () =>
      new Promise<LauncherCapability[]>((resolve) => {
        finish = resolve
      })
  )
  const { result } = renderHook(() =>
    useConversationLaunch({
      ...input(),
      worktreeId: null,
      company: { name: 'Company' },
      loading: true,
      readCapabilities: () => [],
      refreshCapabilities
    })
  )
  act(() => {
    void result.current.start()
    void result.current.start()
  })
  expect(refreshCapabilities).toHaveBeenCalledTimes(1)
  expect(result.current.starting).toBe(true)
  expect(mocks.company).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
  await act(async () => {
    finish(capabilities)
  })
  expect(mocks.company).toHaveBeenCalledTimes(1)
  expect(mocks.error).not.toHaveBeenCalled()
})

it('bounds company detection and never launches after a timeout', async () => {
  let finish!: (value: LauncherCapability[]) => void
  const { result } = renderHook(() =>
    useConversationLaunch({
      ...input(),
      worktreeId: null,
      company: { name: 'Company' },
      loading: true,
      readCapabilities: () => [],
      refreshCapabilities: () =>
        new Promise<LauncherCapability[]>((resolve) => {
          finish = resolve
        })
    })
  )
  act(() => {
    void result.current.start()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_001)
  })
  expect(mocks.error).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish(capabilities)
  })
  expect(mocks.company).not.toHaveBeenCalled()
})

const claim = { key: 'launch-key', ids: ['omnios:closed-unanswered-replies'] }

it('clears the launcher’s one-shot context only once the launch has started', async () => {
  const { result } = renderHook(() => useConversationLaunch(input()))
  await act(async () => {
    void result.current.start({ launchContextClaim: claim })
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(mocks.consume).toHaveBeenCalledWith(claim)

  mocks.consume.mockClear()
  mocks.launch.mockReturnValue({ tabId: 'new', launchCompletion: Promise.resolve(false) })
  await act(async () => {
    void result.current.start({ launchContextClaim: claim })
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(result.current.launchError).toContain('could not start')
  expect(mocks.consume).not.toHaveBeenCalled()
})

it.each([true, false])(
  'clears it after a started company session and keeps it otherwise (started=%s)',
  async (started) => {
    if (!started) {
      mocks.company.mockResolvedValue({ ok: false, reason: 'failed', message: 'Not prepared' })
    }
    const { result } = renderHook(() =>
      useConversationLaunch({ ...input(), worktreeId: null, defaultToWorkRoot: true })
    )
    await act(async () => {
      void result.current.start({ launchContextClaim: claim })
      await vi.advanceTimersByTimeAsync(301)
    })
    expect(mocks.company).toHaveBeenCalled()
    if (started) {
      expect(mocks.consume).toHaveBeenCalledWith(claim)
    } else {
      expect(mocks.consume).not.toHaveBeenCalled()
    }
  }
)

it('clears it for a reserved launch only when the reservation reports a start', async () => {
  const { result } = renderHook(() =>
    useConversationLaunch({
      ...input(),
      loading: true,
      readCapabilities: () => [],
      refreshCapabilities: async () => capabilities
    })
  )
  act(() => {
    void result.current.start({ launchContextClaim: claim })
  })
  const reservation = mocks.reserve.mock.calls[0][0]
  await act(async () => {
    reservation.onSettled()
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(mocks.consume).not.toHaveBeenCalled()
  reservation.onStarted()
  expect(mocks.consume).toHaveBeenCalledWith(claim)
})

it('cancels a delayed host check when the selected computer changes', async () => {
  let finish!: (value: LauncherCapability[]) => void
  const refreshCapabilities = vi.fn(
    () =>
      new Promise<LauncherCapability[]>((resolve) => {
        finish = resolve
      })
  )
  const { result } = renderHook(() =>
    useConversationLaunch({
      ...input(),
      local: false,
      accountEnvironmentId: 'worker',
      loading: true,
      readCapabilities: () => [],
      refreshCapabilities
    })
  )
  act(() => {
    void result.current.start({ agent: 'claude' })
  })
  const draft = mocks.reserve.mock.calls[0][0]
  const verification = draft.verify()
  mocks.state.settings = { activeRuntimeEnvironmentId: 'another-worker' }
  finish(capabilities)
  await expect(verification).rejects.toThrow('selected computer changed')
  expect(draft.scopeIsCurrent()).toBe(false)
  expect(mocks.launch).not.toHaveBeenCalled()
})

it('refuses a reviewed start captured for a different computer before dispatch', async () => {
  const { result, rerender } = renderHook(
    ({ worktreeId, accountEnvironmentId }) =>
      useConversationLaunch({ ...input(), worktreeId, accountEnvironmentId, local: false }),
    { initialProps: { worktreeId: 'first-worktree', accountEnvironmentId: 'first-owner' } }
  )
  const reviewedStart = result.current.start
  rerender({ worktreeId: 'second-worktree', accountEnvironmentId: 'second-owner' })
  await act(async () => {
    void reviewedStart({ agent: 'claude' })
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledWith(
    'The selected computer changed. Reopen the launcher to start there.'
  )
})

it('sends the reviewed team instructions without appending another hidden team prompt', async () => {
  const { result } = renderHook(() =>
    useConversationLaunch({
      ...input(),
      local: false,
      readCapabilities: () => [{ id: 'codex', label: 'Codex', status: 'usable', models: [] }]
    })
  )
  const prepared = result.current.prepareReviewPick({ agent: 'codex', team: true })
  expect(prepared.teamInstructions).toContain('Use Codex subagents')
  const manifest = {
    ...emptyLaunchManifest('Review the checkout'),
    attachments: [
      {
        id: 'instructions:launch-team',
        kind: 'instructions' as const,
        title: 'Team instructions',
        content: 'Use just one worker for this launch.'
      }
    ]
  }
  const reviewed = pickFromLaunchManifest(prepared, manifest)
  await act(async () => {
    void result.current.start(reviewed)
    await vi.advanceTimersByTimeAsync(301)
  })
  expect(mocks.launch).toHaveBeenCalledOnce()
  expect(mocks.launch.mock.calls[0][0].prompt).toBe(reviewed.opening?.prompt)
  expect(mocks.launch.mock.calls[0][0].prompt).not.toContain('Before starting workers')
})

it('captures the selected computer when review opens even if its workspace stays the same', () => {
  mocks.state.settings = { activeRuntimeEnvironmentId: 'first-owner' }
  const { result } = renderHook(() => useConversationLaunch(input()))
  const reviewOwnerIsCurrent = result.current.captureOwner()
  expect(reviewOwnerIsCurrent()).toBe(true)
  mocks.state.settings = { activeRuntimeEnvironmentId: 'second-owner' }
  expect(reviewOwnerIsCurrent()).toBe(false)
})
