import { restoreLegacyChain } from './session-chain-legacy.fixture'
// Compat gate for when a chain may advance. Turn lifecycle, stop confirmation and exit
// cards are about to change what a pane reports; these lock the decisions the runner
// makes from those reports: park on an interrupted turn, advance only on a clean finish,
// and never hand the next step more context than the input limit allows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_CHAIN_INPUT_CHAR_LIMIT } from './session-chain-prompt'

const client = vi.hoisted(() => ({
  listSessionChainsFromHost: vi.fn(),
  upsertSessionChainOnHost: vi.fn(),
  removeSessionChainOnHost: vi.fn(),
  listSessionChainOutputFilesFromHost: vi.fn(),
  readTerminalTailFromHost: vi.fn()
}))
const launch = vi.hoisted(() => ({ launchAgentSessionContinuation: vi.fn() }))
const waits = vi.hoisted(() => {
  class SourceSessionFailedError extends Error {}
  class SourceSessionBlockedError extends SourceSessionFailedError {
    reason = 'prompt'
    paneKey: string | null = null
  }
  return {
    SourceSessionFailedError,
    SourceSessionBlockedError,
    waitForSourceSessionCompletion: vi.fn(),
    createTerminalWaitDependencies: vi.fn(() => ({
      resolveSource: vi.fn().mockResolvedValue({ handle: 'term_src' }),
      waitForIdle: vi.fn(),
      waitForExit: vi.fn()
    }))
  }
})
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    activeWorktreeId: 'folder:f1' as string | null,
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    terminalLayoutsByTabId: {} as Record<string, { root: unknown; activeLeafId: string | null }>,
    agentStatusByPaneKey: {} as Record<
      string,
      { state: string; interrupted?: boolean; updatedAt: number }
    >,
    getKnownWorktreeById: (id: string) =>
      id === 'folder:f1' ? { path: '/Users/me/Webinar' } : undefined
  }
  return {
    state,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: () => {
      for (const listener of listeners) {
        listener()
      }
    }
  }
})

vi.mock('@/lib/session-chain-client', () => client)
vi.mock('@/lib/launch-agent-session-continuation', () => launch)
vi.mock('@/lib/next-session-launch', () => waits)
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: unknown) => unknown) => selector(store.state), {
    getState: store.getState,
    subscribe: store.subscribe
  })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getSettingsForWorktreeRuntimeOwner: () => ({ activeRuntimeEnvironmentId: null })
}))
vi.mock('@/components/terminal-pane/terminal-layout-leaf-ids', () => ({
  collectLeafIdsInOrder: (root: unknown) =>
    root && typeof root === 'object' && 'leafId' in root
      ? [(root as { leafId: string }).leafId]
      : [],
  resolveRootlessTerminalLayoutLeafId: () => null
}))
vi.mock('../../../shared/stable-pane-id', () => ({
  isTerminalLeafId: () => true,
  makePaneKey: (tabId: string, leaf: string) => `${tabId}:${leaf}`
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

const SOURCE_PANE_KEY = 'tab-src:leaf-1'
const session = {
  rowKey: '["local","folder:f1","tab-src:leaf-1"]',
  sessionKey: null,
  worktreeId: 'folder:f1',
  hostId: 'local' as const,
  tabId: 'tab-src',
  paneKey: SOURCE_PANE_KEY,
  kind: 'terminal' as const,
  label: 'Draft session',
  workspaceLabel: 'Webinar',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function importRunner() {
  const runner = await import('./session-chain-runner')
  runner.resetSessionChainsForTests()
  return { ...runner, restoreLegacyChain }
}

function reportStatus(state: string, extra: { interrupted?: boolean } = {}): void {
  store.state.agentStatusByPaneKey[SOURCE_PANE_KEY] = {
    state,
    updatedAt: Date.now(),
    ...extra
  }
  store.emit()
}

function lastPrompt(): string {
  return launch.launchAgentSessionContinuation.mock.calls.at(-1)?.[0].prompt as string
}

describe('when a chain step may advance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    client.upsertSessionChainOnHost.mockImplementation(async (_target, chain) => chain)
    client.removeSessionChainOnHost.mockResolvedValue(undefined)
    client.listSessionChainOutputFilesFromHost.mockResolvedValue({
      outputDir: '/x',
      files: [],
      truncated: false
    })
    client.readTerminalTailFromHost.mockResolvedValue('the first step wrote this')
    waits.waitForSourceSessionCompletion.mockResolvedValue({ handle: 'term_src' })
    store.state.terminalLayoutsByTabId = {}
    store.state.agentStatusByPaneKey = {}
    store.state.activeWorktreeId = 'folder:f1'
    launch.launchAgentSessionContinuation.mockImplementation(async (args) => {
      args.onLaunched?.({ tabId: 'tab-new', promptDelivered: Promise.resolve(true) })
      store.state.terminalLayoutsByTabId['tab-new'] = {
        root: { leafId: 'leaf-new' },
        activeLeafId: 'leaf-new'
      }
      store.state.agentStatusByPaneKey['tab-new:leaf-new'] = {
        state: 'working',
        updatedAt: Date.now()
      }
      store.emit()
      return true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('parks on a turn the person stopped and advances only once the interrupt clears', async () => {
    const runner = await importRunner()
    // The hook reported the turn finished, but as interrupted: a stop is not a result.
    reportStatus('done', { interrupted: true })
    const chain = runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'claude', prompt: 'polish the intro', presetId: 'implement' }],
      auto: true
    })
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(launch.launchAgentSessionContinuation).not.toHaveBeenCalled()
    expect(runner.getSessionChain(chain!.id)).toMatchObject({
      state: 'waiting',
      currentIndex: 0,
      blocked: { paneKey: SOURCE_PANE_KEY, reason: 'interrupted' }
    })

    // The person resumed and the turn ended for real; the same chain carries on.
    reportStatus('done')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
    const advanced = runner.getSessionChain(chain!.id)
    expect(advanced?.currentIndex).toBe(1)
    expect(advanced?.blocked ?? null).toBeNull()
    expect(lastPrompt()).toContain('the first step wrote this')
  })

  it('does not advance while the source agent still reports working', async () => {
    const runner = await importRunner()
    reportStatus('working')
    const chain = runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'claude', prompt: 'polish the intro' }],
      auto: true
    })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(launch.launchAgentSessionContinuation).not.toHaveBeenCalled()
    expect(runner.getSessionChain(chain!.id)).toMatchObject({ state: 'waiting', currentIndex: 0 })

    reportStatus('done')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
  })

  it('hands the next step the previous output, bounded by the input limit', async () => {
    const runner = await importRunner()
    const suffix = 'END OF TRANSCRIPT'
    const tail = `${'x'.repeat(SESSION_CHAIN_INPUT_CHAR_LIMIT * 2)}${suffix}`
    client.readTerminalTailFromHost.mockResolvedValue(tail)
    reportStatus('done')
    runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'claude', prompt: 'polish the intro', presetId: 'implement' }],
      auto: true
    })
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
    const prompt = lastPrompt()
    // The newest end of the transcript survives; the rest is dropped, not the other way round.
    expect(prompt).toContain(`…${'x'.repeat(8)}`)
    expect(prompt).toContain(suffix)
    const longestRun = (prompt.match(/x+/g) ?? []).reduce(
      (longest, run) => (run.length > longest.length ? run : longest),
      ''
    )
    expect(longestRun).toHaveLength(SESSION_CHAIN_INPUT_CHAR_LIMIT - suffix.length)
    expect(prompt).not.toContain(tail)
  })

  it('needs two consecutive shell readings to call a launched agent exited', async () => {
    // Why: one shell reading is not evidence — a tool subprocess or a renamed agent
    // binary can own the foreground for a moment. Only a second consecutive one fails.
    const runner = await importRunner()
    const foreground = vi.fn().mockResolvedValueOnce('zsh').mockResolvedValue('2.1.267')
    waits.createTerminalWaitDependencies.mockImplementation(() => ({
      resolveSource: vi.fn().mockResolvedValue({ handle: 'term_new' }),
      waitForIdle: vi.fn(),
      waitForExit: vi.fn(),
      foregroundProcess: foreground
    }))
    launch.launchAgentSessionContinuation.mockImplementation(async (args) => {
      args.onLaunched?.({ tabId: 'tab-new', promptDelivered: Promise.resolve(true) })
      store.state.terminalLayoutsByTabId['tab-new'] = {
        root: { leafId: 'leaf-new' },
        activeLeafId: 'leaf-new'
      }
      store.emit()
      return true
    })
    reportStatus('done')
    const chain = runner.restoreLegacyChain({
      session,
      steps: [
        { agent: 'claude', prompt: 'first', presetId: 'implement' },
        { agent: 'claude', prompt: 'second', presetId: 'improve' }
      ],
      auto: true
    })
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(foreground.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(runner.getSessionChain(chain!.id)).toMatchObject({ state: 'waiting', currentIndex: 1 })
    expect(runner.getSessionChain(chain!.id)?.error).toBeUndefined()
  })

  it('a chain that came back from a restart waits, and only an automatic one goes on its own', async () => {
    const runner = await importRunner()
    const persisted = (id: string, state: string, auto: boolean) => ({
      id,
      workspacePath: '/Users/me/Webinar',
      worktreeId: 'folder:f1',
      hostId: 'local' as const,
      sourcePaneKey: SOURCE_PANE_KEY,
      sourceRowKey: `row-${id}`,
      auto,
      steps: [
        {
          id: 'step_1',
          agent: 'claude',
          prompt: 'continue',
          presetId: 'implement',
          status: 'queued'
        }
      ],
      currentIndex: 0,
      state,
      createdAt: 1,
      updatedAt: 1
    })
    client.listSessionChainsFromHost.mockResolvedValue([
      persisted('auto', 'waiting', true),
      persisted('manual', 'waiting', false),
      // A chain already parked for a click is not resumed by the load at all.
      persisted('parked', 'ready', true)
    ])
    // The source is still mid-turn when the app comes back.
    reportStatus('working')

    await runner.loadSessionChains()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(launch.launchAgentSessionContinuation).not.toHaveBeenCalled()
    expect(runner.getSessionChain('auto')).toMatchObject({ state: 'waiting' })
    expect(runner.getSessionChain('parked')).toMatchObject({ state: 'ready' })

    reportStatus('done')
    await vi.advanceTimersByTimeAsync(30_000)
    // The automatic chain resumed its wait and carried on; the others waited for a click.
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
    expect(runner.getSessionChain('manual')).toMatchObject({ state: 'ready' })
    expect(runner.getSessionChain('parked')).toMatchObject({ state: 'ready' })

    runner.startReadySessionChain('manual')
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(2)
  })

  it('gives a step without a preset the output folder but no inlined transcript', async () => {
    // Measured behaviour: `{{input}}` only exists in preset templates, so a free-form
    // step never receives the previous transcript inline — its context travels by path.
    const runner = await importRunner()
    reportStatus('done')
    const chain = runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'claude', prompt: 'polish the intro' }],
      auto: true
    })
    await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    const prompt = lastPrompt()
    expect(prompt).toContain('polish the intro')
    expect(prompt).not.toContain('the first step wrote this')
    expect(prompt).toContain(`.omni/runs/${chain?.id}/${chain?.steps[0]?.id}`)
  })
})
