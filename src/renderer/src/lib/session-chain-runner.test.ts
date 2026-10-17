import { restoreCompiledLegacyChain, restoreLegacyChain } from './session-chain-legacy.fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'

const client = vi.hoisted(() => ({
  listSessionChainsFromHost: vi.fn(),
  upsertSessionChainOnHost: vi.fn(),
  removeSessionChainOnHost: vi.fn(),
  listSessionChainOutputFilesFromHost: vi.fn(),
  readTerminalTailFromHost: vi.fn()
}))
const launch = vi.hoisted(() => ({ launchAgentSessionContinuation: vi.fn() }))
const waits = vi.hoisted(() => {
  const defaultDependencies = () => ({
    resolveSource: vi.fn(),
    waitForIdle: vi.fn(),
    waitForExit: vi.fn()
  })
  return {
    defaultDependencies,
    waitForSourceSessionCompletion: vi.fn(),
    createTerminalWaitDependencies: vi.fn(defaultDependencies)
  }
})
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
const activation = vi.hoisted(() => ({ activateAndRevealWorkspace: vi.fn() }))
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    settings: {
      activeRuntimeEnvironmentId: null as string | null,
      agentAccountProfiles: [
        { id: 'p1', label: 'Slot 3', agent: 'claude', configDir: '/pool/slot-3' }
      ]
    },
    activeWorktreeId: 'folder:f1' as string | null,
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    terminalLayoutsByTabId: {} as Record<string, { root: unknown; activeLeafId: string | null }>,
    agentStatusByPaneKey: {} as Record<string, { state: string }>,
    getKnownWorktreeById: (id: string) =>
      id === 'folder:f1' ? { path: '/Users/me/Webinar' } : undefined
  }
  return {
    state,
    listeners,
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
vi.mock('@/lib/worktree-activation', () => activation)
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
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, value),
      fallback
    )
}))

const session = {
  rowKey: '["local","folder:f1","tab-src:leaf-1"]',
  sessionKey: null,
  worktreeId: 'folder:f1',
  hostId: 'local' as const,
  tabId: 'tab-src',
  paneKey: 'tab-src:leaf-1',
  kind: 'terminal' as const,
  label: 'Draft session',
  workspaceLabel: 'Webinar',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

// Why: timers are faked, so a real setTimeout would never fire; drain microtasks instead.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function importRunner() {
  const runner = await import('./session-chain-runner')
  runner.resetSessionChainsForTests()
  return { ...runner, restoreLegacyChain, restoreCompiledLegacyChain }
}

describe('session chain runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    client.upsertSessionChainOnHost.mockImplementation(async (_target, chain) => chain)
    client.removeSessionChainOnHost.mockResolvedValue(undefined)
    client.listSessionChainOutputFilesFromHost.mockResolvedValue({
      outputDir: '/x',
      files: ['/Users/me/Webinar/.omni/runs/c/step_1/intro.md'],
      truncated: false
    })
    client.readTerminalTailFromHost.mockResolvedValue('last assistant message')
    waits.waitForSourceSessionCompletion.mockResolvedValue({ handle: 'term_src' })
    waits.createTerminalWaitDependencies.mockImplementation(waits.defaultDependencies)
    store.state.terminalLayoutsByTabId = {}
    store.state.agentStatusByPaneKey = {}
    store.state.activeWorktreeId = 'folder:f1'
    launch.launchAgentSessionContinuation.mockImplementation(async (args) => {
      args.onLaunched?.({ tabId: 'tab-new', promptDelivered: Promise.resolve(true) })
      store.state.terminalLayoutsByTabId['tab-new'] = {
        root: { leafId: 'leaf-new' },
        activeLeafId: 'leaf-new'
      }
      // Why: the launched agent reports working once the prompt is in; the chain waits for that.
      store.state.agentStatusByPaneKey['tab-new:leaf-new'] = { state: 'working' }
      store.emit()
      return true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds an outcome commit candidate without persisting or starting the renderer runner', async () => {
    const runner = await importRunner()
    const chain = runner.buildCompiledSessionChain({
      session,
      chainId: 'chn_atomic',
      steps: [],
      auto: true,
      end: 'done'
    })
    expect(chain).toMatchObject({ id: 'chn_atomic', state: 'waiting', steps: [] })
    expect(client.upsertSessionChainOnHost).not.toHaveBeenCalled()
    expect(launch.launchAgentSessionContinuation).not.toHaveBeenCalled()
    const structured = runner.buildCompiledSessionChain({
      session: {
        ...session,
        kind: 'structured',
        paneKey: null,
        tabId: 'structured-agent-session-codex_b7796179_e75c_44c3_bb57_c9020551ec83'
      },
      chainId: 'chn_structured',
      steps: [],
      auto: true,
      end: 'done'
    })
    expect(structured?.sourcePaneKey).toMatch(
      /^structured-agent-session-codex_b7796179_e75c_44c3_bb57_c9020551ec83:/
    )
  })

  it('persists the chain, waits on the source, launches each step with its actor and hands files on', async () => {
    const runner = await importRunner()
    const chain = runner.restoreLegacyChain({
      session,
      steps: [
        {
          agent: 'claude',
          prompt: 'draft the intro',
          presetId: 'implement',
          model: 'opus',
          effort: 'max',
          accountChoiceId: 'profile:p1'
        },
        { agent: 'codex', prompt: 'polish it', presetId: 'improve' }
      ],
      auto: false
    })
    expect(chain).not.toBeNull()
    expect(runner.useSessionChainRows).toBeTypeOf('function')
    expect(client.upsertSessionChainOnHost).toHaveBeenCalledWith(
      { kind: 'local' },
      expect.objectContaining({ id: chain?.id, state: 'waiting', currentIndex: 0 })
    )

    await flush()
    await flush()
    expect(waits.waitForSourceSessionCompletion).toHaveBeenCalledTimes(1)
    // Why 1s: the first launch happens at once; the post-delivery grace (3s) still holds the second.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
    expect(launch.launchAgentSessionContinuation.mock.calls[0]?.[0]).toMatchObject({
      agent: 'claude',
      worktreeId: 'folder:f1',
      workspacePath: '/Users/me/Webinar',
      launchPreferences: { model: 'opus', effort: 'max' },
      launchEnv: { CLAUDE_CONFIG_DIR: '/pool/slot-3' }
    })
    const firstPrompt = launch.launchAgentSessionContinuation.mock.calls[0]?.[0].prompt as string
    expect(firstPrompt).toContain('draft the intro')
    expect(firstPrompt).toContain('last assistant message')
    expect(firstPrompt).toContain(
      `/Users/me/Webinar/.omni/runs/${chain?.id}/${chain?.steps[0]?.id}`
    )

    // The second step waits on the pane the first step launched, then receives its files.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(waits.createTerminalWaitDependencies).toHaveBeenLastCalledWith(
      { kind: 'local' },
      { sourcePaneKey: 'tab-new:leaf-new', worktreeId: 'folder:f1' },
      expect.anything()
    )
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(2)
    expect(client.listSessionChainOutputFilesFromHost).toHaveBeenCalledWith(
      { kind: 'local' },
      { workspacePath: '/Users/me/Webinar', chainId: chain?.id, stepId: chain?.steps[0]?.id }
    )
    const secondPrompt = launch.launchAgentSessionContinuation.mock.calls[1]?.[0].prompt as string
    expect(secondPrompt).toContain('/Users/me/Webinar/.omni/runs/c/step_1/intro.md')

    await vi.advanceTimersByTimeAsync(10_000)
    const last = client.upsertSessionChainOnHost.mock.calls.at(-1)?.[1] as SessionChain
    expect(last).toMatchObject({ state: 'done', currentIndex: 2 })
    expect(last.steps.map((step) => step.status)).toEqual(['launched', 'launched'])
    expect(runner.findSessionChainForRow(session.rowKey)).toBeNull()
  })

  it('launches every member of a fan-out after one wait, then waits on all their panes', async () => {
    const runner = await importRunner()
    let launches = 0
    launch.launchAgentSessionContinuation.mockImplementation(async (args) => {
      launches += 1
      const tabId = `tab-${launches}`
      args.onLaunched?.({ tabId, promptDelivered: Promise.resolve(true) })
      store.state.terminalLayoutsByTabId[tabId] = {
        root: { leafId: `leaf-${launches}` },
        activeLeafId: `leaf-${launches}`
      }
      store.state.agentStatusByPaneKey[`${tabId}:leaf-${launches}`] = { state: 'working' }
      store.emit()
      return true
    })
    const chain = runner.restoreCompiledLegacyChain({
      session,
      chainId: 'chn_fan',
      auto: true,
      steps: [
        { id: 'a', agent: 'claude', prompt: 'branch a', group: 'g1', status: 'queued' },
        { id: 'b', agent: 'codex', prompt: 'branch b', group: 'g1', status: 'queued' },
        { id: 'c', agent: 'claude', prompt: 'merge', presetId: 'synthesize', status: 'queued' }
      ]
    })
    expect(chain).not.toBeNull()
    await flush()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)

    // One wait on the source served both members; neither waited on its sibling. The step
    // after the group waited on both launched panes, then launched with both outputs.
    const keyOf = (call: unknown[]): string => (call[1] as { sourcePaneKey: string }).sourcePaneKey
    const waitedOn = (waits.createTerminalWaitDependencies.mock.calls as unknown[][]).map(keyOf)
    expect(waitedOn.filter((key) => key === 'tab-src:leaf-1')).toHaveLength(1)
    expect(waitedOn).toEqual(expect.arrayContaining(['tab-1:leaf-1', 'tab-2:leaf-2']))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(3)
    const mergePrompt = launch.launchAgentSessionContinuation.mock.calls[2]?.[0].prompt as string
    expect(mergePrompt).toContain('Result 1 of 2')
    expect(mergePrompt).toContain('Result 2 of 2')
    const last = client.upsertSessionChainOnHost.mock.calls.at(-1)?.[1] as SessionChain
    expect(last).toMatchObject({ state: 'done', currentIndex: 3 })
  })

  it('resumes a persisted chain after restart and waits for a click unless it is automatic', async () => {
    const runner = await importRunner()
    const persisted = (id: string, auto: boolean): SessionChain => ({
      id,
      workspacePath: '/Users/me/Webinar',
      worktreeId: 'folder:f1',
      hostId: 'local',
      sourcePaneKey: 'tab-src:leaf-1',
      sourceRowKey: `row-${id}`,
      auto,
      steps: [{ id: 'step_1', agent: 'claude', prompt: 'continue', status: 'queued' }],
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    })
    client.listSessionChainsFromHost.mockResolvedValue([
      persisted('manual', false),
      persisted('auto', true),
      { ...persisted('finished', true), state: 'done', currentIndex: 1 },
      { ...persisted('broken', false), state: 'failed', error: 'The agent exited.' }
    ])

    await runner.loadSessionChains()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)

    // Empty finished queues expire; failures stay visible without running again.
    expect(client.removeSessionChainOnHost).toHaveBeenCalledWith({ kind: 'local' }, 'finished')
    expect(client.removeSessionChainOnHost).not.toHaveBeenCalledWith({ kind: 'local' }, 'broken')
    expect(runner.getSessionChain('finished')).toBeNull()
    expect(runner.getSessionChain('broken')).toMatchObject({
      state: 'failed',
      error: 'The agent exited.'
    })
    // Both live chains resumed their wait; only the automatic one launched.
    expect(waits.waitForSourceSessionCompletion).toHaveBeenCalledTimes(2)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
    expect(runner.getSessionChain('manual')).toMatchObject({ state: 'ready' })
    expect(runner.getSessionChain('auto')).toMatchObject({ state: 'done' })

    runner.startReadySessionChain('manual')
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(2)
    expect(runner.getSessionChain('manual')).toMatchObject({ state: 'done' })
  })

  it('cancelling a chain aborts its wait and removes it from the host', async () => {
    const runner = await importRunner()
    waits.waitForSourceSessionCompletion.mockImplementation(
      () => new Promise(() => {}) // never settles
    )
    const chain = runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'claude', prompt: 'x' }],
      auto: false
    })
    await flush()
    expect(runner.findSessionChainForRow(session.rowKey)?.id).toBe(chain?.id)
    runner.cancelSessionChain(chain!.id)
    expect(runner.findSessionChainForRow(session.rowKey)).toBeNull()
    expect(client.removeSessionChainOnHost).toHaveBeenCalledWith({ kind: 'local' }, chain?.id)
    expect(launch.launchAgentSessionContinuation).not.toHaveBeenCalled()
  })

  it('marks the chain failed when a launch cannot start', async () => {
    const runner = await importRunner()
    launch.launchAgentSessionContinuation.mockResolvedValue(false)
    const chain = runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'claude', prompt: 'x' }],
      auto: false
    })
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runner.getSessionChain(chain!.id)).toMatchObject({
      state: 'failed',
      error: 'The next session could not be started.'
    })
    expect(toast.error).toHaveBeenCalledWith(
      'The next agent could not begin work. Check the selected agent’s connection and sign-in, then try Add Next again.'
    )
    // The failure stays on its row (not live, but shown) until the person dismisses it.
    expect(runner.findSessionChainForRow(session.rowKey)).toBeNull()
    expect(runner.findShownSessionChainForRow(session.rowKey)?.id).toBe(chain?.id)
    runner.cancelSessionChain(chain!.id)
    expect(runner.findShownSessionChainForRow(session.rowKey)).toBeNull()
    expect(client.removeSessionChainOnHost).toHaveBeenCalledWith({ kind: 'local' }, chain?.id)
  })

  it('keeps a source read failure visible and does not launch without its context', async () => {
    const runner = await importRunner()
    client.readTerminalTailFromHost.mockRejectedValue(new Error('Source connection unavailable'))
    const chain = runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'codex', prompt: 'Continue this work' }],
      auto: true
    })
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(launch.launchAgentSessionContinuation).not.toHaveBeenCalled()
    expect(runner.getSessionChain(chain!.id)).toMatchObject({
      state: 'failed',
      error: 'Source connection unavailable'
    })
  })

  it('keeps a disconnected source diagnostic while showing a recovery message', async () => {
    const runner = await importRunner()
    client.readTerminalTailFromHost.mockRejectedValue(new Error('terminal_gone'))
    const chain = runner.restoreLegacyChain({
      session,
      steps: [{ agent: 'codex', prompt: 'Continue this work' }],
      auto: true
    })
    await flush()
    await vi.advanceTimersByTimeAsync(1000)

    expect(launch.launchAgentSessionContinuation).not.toHaveBeenCalled()
    expect(runner.getSessionChain(chain!.id)).toMatchObject({
      state: 'failed',
      error: 'terminal_gone'
    })
    expect(toast.error).toHaveBeenCalledWith(
      'The connection to this conversation is no longer available. Reopen it to check the work before trying Add Next again.'
    )
  })

  it('brings a background workspace to the front before launching into it', async () => {
    const runner = await importRunner()
    store.state.activeWorktreeId = 'repo:/somewhere/else'
    runner.restoreLegacyChain({ session, steps: [{ agent: 'claude', prompt: 'x' }], auto: false })
    await flush()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(activation.activateAndRevealWorkspace).toHaveBeenCalledWith('folder:f1')
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
  })

  it('leaves the active workspace alone when the chain already lives there', async () => {
    const runner = await importRunner()
    runner.restoreLegacyChain({ session, steps: [{ agent: 'claude', prompt: 'x' }], auto: false })
    await flush()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(activation.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting when the launched pane shows a non-shell process under another name', async () => {
    const runner = await importRunner()
    // Why: the native Claude binary reports its version as its process name; only a shell is proof.
    const foregroundProcess = vi.fn().mockResolvedValue('2.1.267')
    waits.createTerminalWaitDependencies.mockImplementation(() => ({
      resolveSource: vi.fn().mockResolvedValue({ handle: 'term_new' }),
      waitForIdle: vi.fn(),
      waitForExit: vi.fn(),
      foregroundProcess
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
    const chain = runner.restoreLegacyChain({
      session,
      steps: [
        { agent: 'claude', prompt: 'x' },
        { agent: 'claude', prompt: 'y' }
      ],
      auto: false
    })
    await flush()
    await flush()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(foregroundProcess.mock.calls.length).toBeGreaterThanOrEqual(3)
    // Why: the step is recorded as launched at once; the chain then waits on that pane, not failed.
    expect(runner.getSessionChain(chain!.id)).toMatchObject({ state: 'waiting', currentIndex: 1 })
    expect(runner.getSessionChain(chain!.id)?.error).toBeUndefined()
  })

  it('fails fast when the launched agent exits before it starts working', async () => {
    const runner = await importRunner()
    const foregroundProcess = vi.fn().mockResolvedValue('zsh')
    waits.createTerminalWaitDependencies.mockImplementation(() => ({
      resolveSource: vi.fn().mockResolvedValue({ handle: 'term_new' }),
      waitForIdle: vi.fn(),
      waitForExit: vi.fn(),
      foregroundProcess
    }))
    launch.launchAgentSessionContinuation.mockImplementation(async (args) => {
      args.onLaunched?.({ tabId: 'tab-new', promptDelivered: Promise.resolve(true) })
      store.state.terminalLayoutsByTabId['tab-new'] = {
        root: { leafId: 'leaf-new' },
        activeLeafId: 'leaf-new'
      }
      // Why: the CLI showed a first-run prompt, took the instruction as its answer and exited.
      store.emit()
      return true
    })
    const chain = runner.restoreLegacyChain({
      session,
      steps: [
        { agent: 'claude', prompt: 'x' },
        { agent: 'claude', prompt: 'y' }
      ],
      auto: false
    })
    await flush()
    await flush()
    // Why 12s: two liveness readings 5s apart, well inside the 180s working observation.
    await vi.advanceTimersByTimeAsync(12_000)
    expect(foregroundProcess).toHaveBeenCalledTimes(2)
    expect(runner.getSessionChain(chain!.id)).toMatchObject({ state: 'failed' })
    expect(runner.getSessionChain(chain!.id)?.error).toContain('zsh is in the foreground')
    expect(launch.launchAgentSessionContinuation).toHaveBeenCalledTimes(1)
    expect(waits.waitForSourceSessionCompletion).toHaveBeenCalledTimes(1)
  })
})
