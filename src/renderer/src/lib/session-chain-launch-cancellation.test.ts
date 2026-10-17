import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../../shared/session-chain-types'
import { launchSessionChainStep } from './session-chain-launch'
import { reconcileLaunchedSessionChainStep } from './session-chain-launch-reconciliation'

const calls = vi.hoisted(() => ({
  files: vi.fn(),
  output: vi.fn(),
  launch: vi.fn(),
  pane: vi.fn(),
  working: vi.fn(),
  activate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() }
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: null, activeWorktreeId: 'folder:1' }) }
}))
vi.mock('sonner', () => ({ toast: calls.toast }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: calls.activate }))
vi.mock('@/lib/session-work-output', () => ({ readSessionWorkOutput: calls.output }))
vi.mock('@/lib/session-chain-client', () => ({ listSessionChainOutputFilesFromHost: calls.files }))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  launchAgentSessionContinuation: calls.launch
}))
vi.mock('@/lib/session-chain-prompt', () => ({
  buildSessionChainStepPrompt: () => ({ prompt: 'Review the result' })
}))
vi.mock('@/lib/session-chain-hub-bridge', () => ({ announceChainStep: vi.fn() }))
vi.mock('@/lib/next-session-launch', () => ({ createTerminalWaitDependencies: () => ({}) }))
vi.mock('@/lib/session-chain-support', () => ({
  workspaceRuntimeTarget: () => ({ kind: 'local' }),
  sourcePaneKeysForStep: () => ['prior:leaf'],
  waitForTabPaneKey: calls.pane,
  waitForPaneAgentWorking: calls.working,
  sleepUnlessAborted: async () => {},
  withResolveRetry: (value: unknown) => value
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function savedChain(): SessionChain {
  return {
    id: 'chain-1',
    worktreeId: 'folder:1',
    workspacePath: '/workspace',
    hostId: 'local',
    sourceRowKey: 'source-row',
    sourcePaneKey: 'source:leaf',
    currentIndex: 1,
    state: 'waiting',
    auto: true,
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: 'build',
        agent: 'claude',
        prompt: 'Build',
        status: 'launched',
        launchedPaneKey: 'prior:leaf'
      },
      { id: 'review', agent: 'codex', prompt: 'Review', status: 'queued' }
    ]
  }
}

function preparation() {
  let current: SessionChain | null = savedChain()
  let release!: () => void
  calls.files.mockReturnValue(
    new Promise((resolve) => {
      release = () => resolve({ outputDir: '/workspace/output', files: [], truncated: false })
    })
  )
  const controller = new AbortController()
  const persist = vi.fn(async () => {})
  const running = launchSessionChainStep(
    {
      getChain: () => current,
      update: (patch) => (current = current ? { ...current, ...patch } : null),
      persist
    },
    ['prior-terminal'],
    controller.signal
  )
  return {
    controller,
    running,
    release,
    persist,
    read: () => current,
    replace: (next: SessionChain | null) => {
      current = next
    }
  }
}

describe('chain cancellation before agent launch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls.output.mockResolvedValue('Build result')
    calls.pane.mockResolvedValue('next:leaf')
    calls.working.mockResolvedValue(true)
    calls.launch.mockImplementation(async (args) => {
      if (!args.shouldLaunch()) {
        return false
      }
      args.onLaunched({ tabId: 'next', promptDelivered: Promise.resolve(true) })
      return true
    })
  })

  it.each(['abort', 'removed', 'replaced', 'advanced', 'cancelled', 'step-replaced'] as const)(
    'does not launch when %s while predecessor files are loading',
    async (change) => {
      const pending = preparation()
      expect(calls.files).toHaveBeenCalledOnce()
      expect(calls.launch).not.toHaveBeenCalled()
      if (change === 'abort') {
        pending.controller.abort()
      }
      if (change === 'removed') {
        pending.replace(null)
      }
      if (change === 'replaced') {
        pending.replace({ ...pending.read()!, id: 'chain-2' })
      }
      if (change === 'advanced') {
        pending.replace({ ...pending.read()!, currentIndex: 2 })
      }
      if (change === 'cancelled') {
        pending.replace({ ...pending.read()!, state: 'cancelled' })
      }
      if (change === 'step-replaced') {
        pending.replace({
          ...pending.read()!,
          steps: pending
            .read()!
            .steps.map((step) =>
              step.id === 'review' ? { ...step, id: 'different-review' } : step
            )
        })
      }
      pending.release()
      await pending.running

      expect(calls.launch).not.toHaveBeenCalled()
      expect(calls.activate).not.toHaveBeenCalled()
      expect(calls.toast.success).not.toHaveBeenCalled()
      expect(pending.persist).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['prompt', { prompt: 'Different instruction' }],
    ['agent', { agent: 'claude' }],
    ['model', { model: 'new-model' }],
    ['effort', { effort: 'high' }],
    ['account', { accountChoiceId: 'profile:new' }],
    [
      'review',
      {
        review: {
          groupId: 'reviews',
          reviewerId: 'r1',
          round: 1,
          maxRounds: 2,
          candidateVersion: 'new'
        }
      }
    ]
  ] satisfies [string, Partial<SessionChainAgentStep>][])(
    'rejects a same-ID %s edit during file preparation',
    async (_name, patch) => {
      const pending = preparation()
      const edited = {
        ...pending.read()!,
        steps: pending
          .read()!
          .steps.map((step) =>
            step.id === 'review' && step.kind !== 'handoff' ? { ...step, ...patch } : step
          )
      }
      pending.replace(edited)
      pending.release()
      await pending.running
      expect(calls.launch).not.toHaveBeenCalled()
      expect(pending.persist).not.toHaveBeenCalled()
      expect(pending.read()).toBe(edited)
    }
  )

  it.each([
    ['sourcePaneKey', 'different:leaf'],
    ['sourceWorktreeId', 'folder:other'],
    ['workspacePath', '/different'],
    ['hostId', 'ssh:other'],
    ['placement', 'ssh:other']
  ] as const)('rejects a changed %s during preparation', async (field, value) => {
    const pending = preparation()
    const edited = { ...pending.read()!, [field]: value }
    pending.replace(edited)
    pending.release()
    await pending.running
    expect(calls.launch).not.toHaveBeenCalled()
    expect(pending.persist).not.toHaveBeenCalled()
    expect(pending.read()).toBe(edited)
  })

  it('allows a refreshed record for the same pending step', async () => {
    const pending = preparation()
    pending.replace({ ...structuredClone(pending.read()!), updatedAt: 2, error: null })
    pending.release()
    await pending.running

    expect(calls.launch).toHaveBeenCalledOnce()
    expect(pending.read()?.steps[1]).toMatchObject({
      status: 'launched',
      launchedPaneKey: 'next:leaf'
    })
    expect(pending.persist).toHaveBeenCalledTimes(2)
  })

  it('keeps later-step edits made during pane discovery', async () => {
    const pending = preparation()
    const later: SessionChainAgentStep = {
      id: 'later',
      agent: 'claude',
      prompt: 'Keep this new instruction',
      status: 'queued'
    }
    calls.pane.mockImplementationOnce(async () => {
      pending.replace({ ...pending.read()!, steps: [...pending.read()!.steps, later] })
      return 'next:leaf'
    })
    pending.release()
    await pending.running
    expect(pending.read()?.steps[2]).toEqual(later)
    expect(pending.read()?.currentIndex).toBe(2)
  })

  it.each(['abort', 'replacement'] as const)(
    'keeps the launch receipt and does not observe after %s during pane discovery',
    async (change) => {
      const pending = preparation()
      calls.pane.mockImplementationOnce(async () => {
        await Promise.resolve()
        if (change === 'abort') {
          pending.controller.abort()
        } else {
          pending.replace({ ...pending.read()!, id: 'replacement' })
        }
        return 'next:leaf'
      })
      pending.release()
      await pending.running
      expect(pending.persist).toHaveBeenCalledOnce()
      if (change === 'abort') {
        expect(pending.read()?.steps[1]).toMatchObject({
          status: 'launched',
          launchedTabId: 'next'
        })
      }
      expect(calls.working).not.toHaveBeenCalled()
      expect(calls.toast.success).not.toHaveBeenCalled()
    }
  )

  it('persists a returned launch before pane discovery, then resumes it without relaunching', async () => {
    const pending = preparation()
    let resolvePane!: (pane: string) => void
    calls.pane.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolvePane = resolve
        })
    )
    pending.release()
    await vi.waitFor(() => expect(pending.persist).toHaveBeenCalledOnce())
    expect(pending.read()?.steps[1]).toMatchObject({
      status: 'launched',
      launchedTabId: 'next'
    })

    pending.controller.abort()
    resolvePane('next:leaf')
    await pending.running
    expect(calls.launch).toHaveBeenCalledOnce()
    expect(pending.read()?.currentIndex).toBe(1)

    calls.pane.mockResolvedValueOnce('next:leaf')
    await reconcileLaunchedSessionChainStep(
      {
        getChain: pending.read,
        update: (patch) => {
          const next = { ...pending.read()!, ...patch }
          pending.replace(next)
          return next
        },
        persist: pending.persist
      },
      new AbortController().signal
    )
    expect(calls.launch).toHaveBeenCalledOnce()
    expect(pending.read()?.steps[1]).toMatchObject({
      status: 'launched',
      launchedTabId: 'next',
      launchedPaneKey: 'next:leaf'
    })
    expect(pending.read()?.currentIndex).toBe(2)
  })

  it('does not observe or claim success after cancellation during prompt delivery', async () => {
    const pending = preparation()
    let releaseDelivery!: (delivered: boolean) => void
    const promptDelivered = new Promise<boolean>((resolve) => {
      releaseDelivery = resolve
    })
    calls.launch.mockImplementationOnce(async (args) => {
      args.onLaunched({ tabId: 'next', promptDelivered })
      return true
    })
    pending.release()
    await vi.waitFor(() => expect(pending.persist.mock.calls.length).toBeGreaterThanOrEqual(1))
    pending.controller.abort()
    releaseDelivery(false)
    await expect(pending.running).resolves.toBeUndefined()
    expect(pending.persist).toHaveBeenCalledTimes(2)
    expect(calls.working).not.toHaveBeenCalled()
    expect(calls.toast.success).not.toHaveBeenCalled()
  })

  it('refuses a same-ID instruction edit during agent preflight', async () => {
    const pending = preparation()
    calls.launch.mockImplementationOnce(async (args) => {
      pending.replace({
        ...pending.read()!,
        steps: pending
          .read()!
          .steps.map((step) =>
            step.kind !== 'handoff' && step.id === 'review'
              ? { ...step, prompt: 'New instruction' }
              : step
          )
      })
      expect(args.shouldLaunch()).toBe(false)
      return false
    })
    pending.release()
    await expect(pending.running).resolves.toBeUndefined()
    expect(pending.persist).not.toHaveBeenCalled()
    expect(calls.pane).not.toHaveBeenCalled()
  })

  it('does not report a launch failure when cancelled during agent preflight', async () => {
    const pending = preparation()
    calls.launch.mockImplementation(async (args) => {
      pending.controller.abort()
      expect(args.shouldLaunch()).toBe(false)
      return false
    })
    pending.release()
    await expect(pending.running).resolves.toBeUndefined()
    expect(calls.toast.success).not.toHaveBeenCalled()
    expect(pending.persist).not.toHaveBeenCalled()
  })
})
