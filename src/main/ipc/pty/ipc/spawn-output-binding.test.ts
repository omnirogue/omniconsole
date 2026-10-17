import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationOutputBindingRequest } from '../../../../shared/automations-types'
import type { bindAutomationOutputLaunch } from '../../../automations/automation-output-binding'
import type { Store } from '../../../persistence'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityTerminalAuthority
} from '../../../runtime/omni-runtime'
import { noCodexResumeLaunch } from '../host-env/codex-resume'
import type { admitRendererAgentLaunchAuthority } from '../pane/launch-authority'
import { commitPtyIpcSpawn } from './spawn-commit'
import type { persistPtyIpcSpawnCommit } from './spawn-commit-persist'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
// Why: a Claude spawn here must not write this machine's real Claude config.
vi.mock('../../../claude-accounts/claude-diff-panel-pty', () => ({
  keepClaudeDiffPanelClosedForPty: vi.fn()
}))

const mocks = vi.hoisted(() => ({
  persist: vi.fn<typeof persistPtyIpcSpawnCommit>(),
  admit: vi.fn<typeof admitRendererAgentLaunchAuthority>(),
  bind: vi.fn<typeof bindAutomationOutputLaunch>()
}))

vi.mock('./spawn-commit-persist', () => ({ persistPtyIpcSpawnCommit: mocks.persist }))
vi.mock('../pane/launch-authority', () => ({
  admitRendererAgentLaunchAuthority: mocks.admit,
  admitProviderReattachLaunchIdentity: vi.fn(() => null)
}))
vi.mock('../../../automations/automation-output-binding', () => ({
  bindAutomationOutputLaunch: mocks.bind
}))
vi.mock('../provider/registry', () => ({ localProvider: {} }))
vi.mock('../pane/resume-task-link', () => ({ carryResumedTaskForSpawn: vi.fn() }))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { registerPaneKeyAlias: vi.fn() }
}))
vi.mock('../../../claude-accounts/live-pty-gate', () => ({ markClaudePtySpawned: vi.fn() }))
vi.mock('../../../memory/pty-registry', () => ({ registerPty: vi.fn() }))
vi.mock('../../../agent-hooks/migration-unsupported-pty-state', () => ({
  clearMigrationUnsupportedPtysForPaneKey: vi.fn()
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
vi.mock('../host-env/codex-home', () => ({
  shouldSkipCodexHomeEnvForWindowsShell: vi.fn(() => false),
  codexReattachedHomeRouteField: vi.fn(() => ({}))
}))
vi.mock('../host-env/codex-resume', () => ({
  noCodexResumeLaunch: (command: string | undefined) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
}))
vi.mock('../pane/key-state', () => ({
  rememberPaneKeyForPty: vi.fn((_id: string, paneKey: string) => paneKey)
}))
vi.mock('./session-capabilities', () => ({ recordSpawnSessionCapabilities: vi.fn() }))
vi.mock('../pane/agent-session-owners', () => ({
  seedTerminalRestoreRecordsFromSpawnResult: vi.fn()
}))

const TAB_ID = 'tab-output-binding'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const REQUEST: AutomationOutputBindingRequest = {
  automationId: 'automation-1',
  runId: 'run-1',
  token: 'fixture-binding-token'
}
const ADMITTED = { launchToken: 'accepted-launch-token', launchAgent: 'codex' } as const
const AUTHORITY: OrchestrationCompatibilityTerminalAuthority = {
  runtimeId: 'runtime-1',
  terminalHandle: 'actual-terminal-handle',
  ptyId: 'spawned-pty',
  worktreeId: 'workspace-1',
  processIncarnation: 'spawned-pty:incarnation-1',
  paneKey: PANE_KEY,
  launchTokenHash: 'accepted-launch-token-hash',
  hostScope: { kind: 'local', hostId: 'local' }
}

function harness() {
  const runtime = {
    registerPty: vi.fn<OrcaRuntimeService['registerPty']>(),
    seedHeadlessTerminal: vi.fn<OrcaRuntimeService['seedHeadlessTerminal']>(),
    noteTerminalSpawnCommand: vi.fn<OrcaRuntimeService['noteTerminalSpawnCommand']>(),
    admitHubLinkedTerminalLaunch: vi
      .fn<OrcaRuntimeService['admitHubLinkedTerminalLaunch']>()
      .mockResolvedValue(undefined),
    getTerminalHandleForPaneKey: vi
      .fn<OrcaRuntimeService['getTerminalHandleForPaneKey']>()
      .mockReturnValue(AUTHORITY.terminalHandle),
    getOrchestrationDispatchAuthority: vi
      .fn<OrcaRuntimeService['getOrchestrationDispatchAuthority']>()
      .mockReturnValue(AUTHORITY)
  }
  const store = {
    listAutomations: vi.fn<Store['listAutomations']>().mockReturnValue([]),
    listAutomationRuns: vi.fn<Store['listAutomationRuns']>().mockReturnValue([])
  }
  const deps: PtySpawnIpcDeps = {
    // The class-backed services are limited to the typed methods this commit can access.
    runtime: runtime as unknown as OrcaRuntimeService,
    store: store as unknown as Store,
    getLocalPtyStartupPromise: vi.fn(() => undefined),
    adoptStablePane: vi.fn(async () => null),
    assertFolderWorkspacePtyPathUsable: vi.fn(),
    resolvePtySpawnStartupCwd: vi.fn<PtySpawnIpcDeps['resolvePtySpawnStartupCwd']>(
      (_worktreeId, cwd) => cwd
    ),
    localStartupCwdDirectoryExists: vi.fn(() => true),
    prepareCodexResumeHome: vi.fn(() => null),
    noCodexResumeLaunch,
    resolveCodexResumeLaunch: vi.fn(async () => noCodexResumeLaunch(undefined)),
    reconcileSharedRuntimeResumeHome: vi.fn(async () => 'fixture-home'),
    stripSequencedStartupResumeArgv: (env) => env,
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    trustedTerminalHandleEnv: new Set(),
    sendPtySpawnedToRenderer: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn()
  }
  const args: PtySpawnIpcArgs = {
    cols: 80,
    rows: 24,
    worktreeId: AUTHORITY.worktreeId,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    launchToken: 'renderer-claimed-launch-token',
    automationOutputBinding: REQUEST,
    env: { ORCA_TERMINAL_HANDLE: 'renderer-claimed-handle' }
  }
  const ctx = createPtyIpcSpawnState(deps, args)
  ctx.result = { id: AUTHORITY.ptyId, incarnationId: 'incarnation-1' }
  ctx.validatedPaneKey = PANE_KEY
  ctx.metadataLeafId = LEAF_ID
  ctx.pendingRegistrationPtyId = AUTHORITY.ptyId
  ctx.preAllocatedHandle = 'stale-preallocated-handle'
  ctx.effectiveLaunchConfig = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
  return { ctx, runtime, store }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.persist.mockReset().mockResolvedValue({
    rendererPreSignaled: true,
    rendererAlreadyRegistered: false
  })
  mocks.admit.mockReset().mockReturnValue(ADMITTED)
  mocks.bind.mockReset().mockReturnValue(true)
})

describe('spawn commit automation output binding', () => {
  it('binds after registration using the accepted agent and authority of the current pane handle', async () => {
    const { ctx, runtime, store } = harness()

    await expect(commitPtyIpcSpawn(ctx)).resolves.toMatchObject({ id: AUTHORITY.ptyId })

    expect(runtime.registerPty).toHaveBeenCalledWith(
      AUTHORITY.ptyId,
      AUTHORITY.worktreeId,
      null,
      expect.objectContaining({ agentLaunchAuthority: ADMITTED }),
      false
    )
    expect(runtime.getTerminalHandleForPaneKey).toHaveBeenCalledExactlyOnceWith(PANE_KEY)
    expect(runtime.getOrchestrationDispatchAuthority).toHaveBeenCalledExactlyOnceWith(
      AUTHORITY.terminalHandle
    )
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith({
      request: REQUEST,
      authority: AUTHORITY,
      agent: ADMITTED.launchAgent,
      store
    })
    const order = [
      runtime.registerPty,
      runtime.getTerminalHandleForPaneKey,
      runtime.getOrchestrationDispatchAuthority,
      mocks.bind,
      runtime.admitHubLinkedTerminalLaunch,
      ctx.deps.sendPtySpawnedToRenderer
    ].map((mock) => vi.mocked(mock).mock.invocationCallOrder[0]!)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(ctx.pendingRegistrationPtyId).toBeNull()
  })

  it('does not inspect runtime authority, store records, or bindings when no request was supplied', async () => {
    const { ctx, runtime, store } = harness()
    delete ctx.args.automationOutputBinding

    await expect(commitPtyIpcSpawn(ctx)).resolves.toMatchObject({ id: AUTHORITY.ptyId })

    expect(runtime.registerPty).toHaveBeenCalledOnce()
    expect(runtime.getTerminalHandleForPaneKey).not.toHaveBeenCalled()
    expect(runtime.getOrchestrationDispatchAuthority).not.toHaveBeenCalled()
    expect(store.listAutomations).not.toHaveBeenCalled()
    expect(store.listAutomationRuns).not.toHaveBeenCalled()
    expect(mocks.bind).not.toHaveBeenCalled()
  })

  it.each(['reattach', 'stable owner', 'not admitted'] as const)(
    'skips binding for a %s spawn',
    async (reason) => {
      const { ctx, runtime } = harness()
      if (reason === 'reattach') {
        ctx.result.isReattach = true
      }
      if (reason === 'stable owner') {
        ctx.stablePaneOwner = { tabId: TAB_ID, leafId: LEAF_ID, ptyId: 'existing-pty' }
      }
      if (reason === 'not admitted') {
        mocks.admit.mockReturnValueOnce(null)
      }

      await expect(commitPtyIpcSpawn(ctx)).resolves.toMatchObject({ id: AUTHORITY.ptyId })

      expect(runtime.getTerminalHandleForPaneKey).not.toHaveBeenCalled()
      expect(runtime.getOrchestrationDispatchAuthority).not.toHaveBeenCalled()
      expect(mocks.bind).not.toHaveBeenCalled()
    }
  )

  it.each(['runtime', 'store', 'pane'] as const)(
    'skips optional proof when %s is missing',
    async (missing) => {
      const { ctx, runtime } = harness()
      if (missing === 'runtime') {
        delete ctx.deps.runtime
      }
      if (missing === 'store') {
        delete ctx.deps.store
      }
      if (missing === 'pane') {
        ctx.validatedPaneKey = null
      }

      await expect(commitPtyIpcSpawn(ctx)).resolves.toMatchObject({ id: AUTHORITY.ptyId })

      expect(runtime.getTerminalHandleForPaneKey).not.toHaveBeenCalled()
      expect(runtime.getOrchestrationDispatchAuthority).not.toHaveBeenCalled()
      expect(mocks.bind).not.toHaveBeenCalled()
      expect(ctx.deps.sendPtySpawnedToRenderer).toHaveBeenCalledWith(AUTHORITY.ptyId)
    }
  )

  it.each(['missing handle', 'missing authority', 'displaced PTY'] as const)(
    'passes no authority when the pane has a %s',
    async (missing) => {
      const { ctx, runtime } = harness()
      if (missing === 'missing handle') {
        runtime.getTerminalHandleForPaneKey.mockReturnValue(null)
      }
      if (missing === 'missing authority') {
        runtime.getOrchestrationDispatchAuthority.mockReturnValue(null)
      }
      if (missing === 'displaced PTY') {
        runtime.getOrchestrationDispatchAuthority.mockReturnValue({
          ...AUTHORITY,
          ptyId: 'different-pty'
        })
      }

      await expect(commitPtyIpcSpawn(ctx)).resolves.toMatchObject({ id: AUTHORITY.ptyId })

      expect(mocks.bind).toHaveBeenCalledWith(expect.objectContaining({ authority: null }))
      if (missing === 'missing handle') {
        expect(runtime.getOrchestrationDispatchAuthority).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['rejected binding', 'binder error', 'handle error', 'authority error'] as const)(
    'finishes an accepted spawn after %s',
    async (failure) => {
      const { ctx, runtime } = harness()
      const throwProofError = (): never => {
        throw new Error('Proof unavailable')
      }
      if (failure === 'rejected binding') {
        mocks.bind.mockReturnValueOnce(false)
      }
      if (failure === 'binder error') {
        mocks.bind.mockImplementationOnce(throwProofError)
      }
      if (failure === 'handle error') {
        runtime.getTerminalHandleForPaneKey.mockImplementationOnce(throwProofError)
      }
      if (failure === 'authority error') {
        runtime.getOrchestrationDispatchAuthority.mockImplementationOnce(throwProofError)
      }

      await expect(commitPtyIpcSpawn(ctx)).resolves.toMatchObject({ id: AUTHORITY.ptyId })

      expect(runtime.admitHubLinkedTerminalLaunch).toHaveBeenCalledOnce()
      expect(ctx.deps.sendPtySpawnedToRenderer).toHaveBeenCalledWith(AUTHORITY.ptyId)
      expect(ctx.pendingRegistrationPtyId).toBeNull()
    }
  )
})
