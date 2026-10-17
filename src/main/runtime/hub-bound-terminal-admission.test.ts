import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { mintConsoleLaunchGate } from '../pty/console-launch-authority'
import { OrcaRuntimeService } from './omni-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

type CreateOptions = NonNullable<Parameters<OrcaRuntimeService['createTerminal']>[1]>
const HUB_TASK = 'btk_admission1234'
const BOUND_ENV = { OMNI_TASK_ID: HUB_TASK }
const WORKSPACE = {
  id: 'worktree-admission',
  path: '/tmp/worktree-admission',
  connectionId: null,
  repo: null,
  folderWorkspace: null
}

function harness() {
  let hubTaskId: string | undefined
  const settings = {
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {}
  }
  const persist = vi.fn()
  const runtime = new OrcaRuntimeService({
    getSettings: () => settings,
    getWorktreeMeta: () => ({
      linkedWorkItem: hubTaskId ? { hubTaskId, title: 'Hub task' } : undefined
    }),
    getFolderWorkspaces: () => [],
    getRepo: () => undefined,
    getRepos: () => [],
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: persist
  } as never)
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<typeof WORKSPACE>
    resolveAgentTerminalCreateOptions: (
      workspace: typeof WORKSPACE,
      opts: CreateOptions
    ) => Promise<CreateOptions>
    buildTerminalWorkspaceEnv: (...args: unknown[]) => Record<string, string>
    markWorkspaceTrustedForAgent: (...args: unknown[]) => Promise<void>
    getAvailableAuthoritativeWindow: () => unknown
    assertGraphReady: () => void
    agentSessionCreateOperations: Map<string, unknown>
    agentSessionClaimSigner: { createClaim: (...args: unknown[]) => unknown }
    resolveNewSessionOptions: (
      ...args: unknown[]
    ) => Promise<Readonly<Record<string, string>> | undefined>
  }
  const resolveWorkspace = vi
    .spyOn(internal, 'resolveTerminalWorkspaceLaunchScope')
    .mockResolvedValue(WORKSPACE)
  const trust = vi.spyOn(internal, 'markWorkspaceTrustedForAgent').mockResolvedValue()
  const sessionClaim = vi.spyOn(internal.agentSessionClaimSigner, 'createClaim')
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-admission' })
  const releaseClaim = vi.fn()
  const claim = vi.fn(() => releaseClaim)
  const adopt = vi.fn().mockResolvedValue(null)
  const releaseLaunchGate = vi.fn()
  runtime.setPtyController({
    spawn,
    releaseLaunchGate,
    readLaunchGateObservation: vi.fn(),
    claimStablePaneCreate: claim,
    adoptStablePane: adopt,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const send = vi.fn()
  const reveal = vi.fn().mockResolvedValue({ tabId: 'tab-admission' })
  const split = vi.fn()
  runtime.setNotifier({ revealTerminalSession: reveal, splitTerminal: split } as never)
  return {
    runtime,
    internal,
    settings,
    spawn,
    claim,
    sessionClaim,
    releaseClaim,
    releaseLaunchGate,
    adopt,
    persist,
    trust,
    send,
    reveal,
    split,
    resolveWorkspace,
    bind: () => {
      hubTaskId = HUB_TASK
    },
    renderer: () => {
      vi.spyOn(internal, 'getAvailableAuthoritativeWindow').mockReturnValue({
        id: 1,
        webContents: { send }
      })
      vi.spyOn(internal, 'assertGraphReady').mockImplementation(() => {})
    }
  }
}

function boundGate(worktreeId = WORKSPACE.id) {
  return mintConsoleLaunchGate({
    taskId: HUB_TASK,
    worktreeId,
    cwd: WORKSPACE.path,
    validate: async () => {},
    assertCurrent: () => undefined
  })
}

function expectNoLaunch(h: ReturnType<typeof harness>, beforeClaim = true) {
  expect(h.spawn).not.toHaveBeenCalled()
  expect(h.send).not.toHaveBeenCalled()
  expect(h.reveal).not.toHaveBeenCalled()
  expect(h.split).not.toHaveBeenCalled()
  expect(h.persist).not.toHaveBeenCalled()
  expect(h.sessionClaim).not.toHaveBeenCalled()
  if (beforeClaim) {
    expect(h.claim).not.toHaveBeenCalled()
  }
  expect(h.internal.agentSessionCreateOperations.size).toBe(0)
}

beforeEach(() => installFakeAppEnvironment())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Hub-bound public terminal admission', () => {
  it('starts the authorized bound agent through a real minted gate and preserves its closed receipt', async () => {
    const h = harness()
    h.bind()
    const launchGate = boundGate()
    const receipt: PtyLaunchGateReceipt = {
      version: 1,
      state: 'closed',
      launchId: launchGate.launchId,
      gateId: randomUUID(),
      ptyId: 'pty-admission',
      incarnationId: randomUUID(),
      pid: 431,
      processStartTimeMs: 1788900000000,
      processKind: 'pty-root',
      reportsChildExitStatus: true,
      startupCommandMode: 'exec'
    }
    h.spawn.mockResolvedValue({
      id: receipt.ptyId,
      pid: receipt.pid,
      incarnationId: receipt.incarnationId,
      launchGate: receipt
    })

    const terminal = await h.runtime.createTerminal('id:worktree-admission', {
      startupAgent: 'codex',
      launchPreferences: { model: 'admission-fixture-model' },
      hubTaskId: HUB_TASK,
      launchGate,
      presentation: 'background'
    })

    expect(terminal).toMatchObject({
      ptyId: receipt.ptyId,
      processId: receipt.pid,
      worktreeId: WORKSPACE.id,
      launchGate: receipt
    })
    expect(h.trust).toHaveBeenCalledOnce()
    expect(h.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        worktreeId: WORKSPACE.id,
        cwd: WORKSPACE.path,
        launchAgent: 'codex',
        command: expect.stringContaining('codex'),
        env: expect.objectContaining(BOUND_ENV)
      })
    )
    expect(h.spawn.mock.calls[0][0].launchGate).toBe(launchGate)
    expect(h.claim).toHaveBeenCalledOnce()
    expect(h.releaseClaim).toHaveBeenCalledOnce()
    expect(h.adopt).not.toHaveBeenCalled()
    expect(h.releaseLaunchGate).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'refuses a copied minted gate before launch effects (explicit binding=%s)',
    async (explicitBinding) => {
      const h = harness()
      h.bind()
      await expect(
        h.runtime.createTerminal('id:worktree-admission', {
          startupAgent: 'codex',
          ...(explicitBinding ? { hubTaskId: HUB_TASK } : {}),
          launchGate: { ...boundGate() },
          presentation: 'background'
        })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(h.resolveWorkspace).toHaveBeenCalledTimes(explicitBinding ? 0 : 1)
      expect(h.trust).not.toHaveBeenCalled()
      expectNoLaunch(h)
    }
  )

  it('refuses a real gate minted for another workspace before trusting or spawning an agent', async () => {
    const h = harness()
    h.bind()
    await expect(
      h.runtime.createTerminal('id:worktree-admission', {
        startupAgent: 'codex',
        hubTaskId: HUB_TASK,
        launchGate: boundGate('another-workspace')
      })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(h.resolveWorkspace).toHaveBeenCalledOnce()
    expect(h.trust).not.toHaveBeenCalled()
    expectNoLaunch(h)
  })

  it('refuses a different task in the final environment despite a real gate', async () => {
    const h = harness()
    vi.spyOn(h.internal, 'buildTerminalWorkspaceEnv').mockReturnValue({
      OMNI_TASK_ID: 'btk_anothertask1234'
    })
    await expect(
      h.runtime.createTerminal('id:worktree-admission', {
        env: BOUND_ENV,
        launchGate: boundGate(),
        presentation: 'background'
      })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expectNoLaunch(h, false)
    expect(h.releaseClaim).toHaveBeenCalledOnce()
  })

  it.each([
    { env: BOUND_ENV },
    { env: { OMNI_TASK_ID: 'malformed-but-known-binding' } },
    { launchAgent: 'codex', launchConfig: { agentArgs: '', agentEnv: BOUND_ENV } },
    { startupAgent: 'codex', hubTaskId: HUB_TASK }
  ] satisfies CreateOptions[])(
    'refuses explicit binding before workspace, claim, or spawn: %j',
    async (opts) => {
      const h = harness()
      await expect(h.runtime.createTerminal('id:worktree-admission', opts)).rejects.toMatchObject({
        code: 'consumer_fenced'
      })
      expect(h.resolveWorkspace).not.toHaveBeenCalled()
      expect(h.trust).not.toHaveBeenCalled()
      expectNoLaunch(h)
    }
  )

  it('refuses explicit binding on the renderer path before sending a tab request', async () => {
    const h = harness()
    h.renderer()
    await expect(
      h.runtime.createTerminal(undefined, { rendererBacked: true, env: BOUND_ENV })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expectNoLaunch(h)
  })

  it.each([false, true])(
    'refuses binding resolved after an await (renderer=%s)',
    async (renderer) => {
      const h = harness()
      if (renderer) {
        h.renderer()
      }
      vi.spyOn(h.internal, 'resolveAgentTerminalCreateOptions').mockImplementation(
        async (_scope, opts) => {
          await Promise.resolve()
          return {
            ...opts,
            launchAgent: 'codex',
            launchConfig: { agentArgs: '', agentEnv: BOUND_ENV }
          }
        }
      )
      await expect(
        h.runtime.createTerminal('id:worktree-admission', { rendererBacked: renderer })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expectNoLaunch(h)
    }
  )

  it('checks the actual final merged environment before provider spawn', async () => {
    const h = harness()
    vi.spyOn(h.internal, 'buildTerminalWorkspaceEnv').mockReturnValue(BOUND_ENV)
    await expect(h.runtime.createTerminal('id:worktree-admission')).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expectNoLaunch(h, false)
    expect(h.releaseClaim).toHaveBeenCalledOnce()
  })

  it('refuses a workspace binding added while provider launch resolution awaits', async () => {
    const h = harness()
    h.resolveWorkspace.mockImplementation(async () => {
      await Promise.resolve()
      h.bind()
      return WORKSPACE
    })
    await expect(
      h.runtime.createTerminal('id:worktree-admission', { startupAgent: 'codex' })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(h.trust).not.toHaveBeenCalled()
    expectNoLaunch(h)
  })

  it('rechecks workspace binding after asynchronous pane adoption', async () => {
    const h = harness()
    h.adopt.mockImplementation(async () => {
      await Promise.resolve()
      h.bind()
      return null
    })
    await expect(
      h.runtime.createTerminal('id:worktree-admission', { launchAgent: 'codex' })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expectNoLaunch(h, false)
    expect(h.releaseClaim).toHaveBeenCalledOnce()
  })

  it('keeps an ordinary unbound shell usable in a Hub-linked workspace', async () => {
    const h = harness()
    h.bind()
    await expect(
      h.runtime.createTerminal('id:worktree-admission', { presentation: 'background' })
    ).resolves.toMatchObject({ ptyId: 'pty-admission' })
    expect(h.spawn).toHaveBeenCalledOnce()
    expect(h.spawn.mock.calls[0][0].env.OMNI_TASK_ID).toBeUndefined()
  })

  it('keeps explicitly empty task environment usable', async () => {
    const h = harness()
    await expect(
      h.runtime.createTerminal('id:worktree-admission', {
        env: { OMNI_TASK_ID: '' },
        presentation: 'background'
      })
    ).resolves.toMatchObject({ ptyId: 'pty-admission' })
    expect(h.spawn).toHaveBeenCalledOnce()
  })

  it('refuses a split binding before looking up the source or notifying a renderer', async () => {
    const h = harness()
    await expect(
      h.runtime.splitTerminal('term-not-looked-up', { env: BOUND_ENV })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expectNoLaunch(h)
  })

  it('checks a split final environment after resolving an existing source pane', async () => {
    const h = harness()
    const source = await h.runtime.createTerminal('id:worktree-admission', {
      presentation: 'background'
    })
    vi.clearAllMocks()
    vi.spyOn(h.internal, 'buildTerminalWorkspaceEnv').mockReturnValue(BOUND_ENV)
    await expect(h.runtime.splitTerminal(source.handle)).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expectNoLaunch(h)
  })
})

describe('Hub-bound structured agent session admission', () => {
  it.each(['create', 'ensure'] as const)(
    'refuses inherited workspace binding before %s trust or terminal effects',
    async (kind) => {
      const h = harness()
      h.bind()
      const createTerminal = vi.spyOn(h.runtime, 'createTerminal')
      const operation =
        kind === 'create'
          ? h.runtime.createAgentSession({
              clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
              worktree: 'id:worktree-admission',
              agent: 'codex',
              prompt: 'test'
            })
          : h.runtime.ensureAgentSession({
              kind: 'explicit',
              worktree: 'id:worktree-admission',
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'provider-session' }
            })
      await expect(operation).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(createTerminal).not.toHaveBeenCalled()
      expect(h.trust).not.toHaveBeenCalled()
      expectNoLaunch(h)
    }
  )

  it.each(['create', 'ensure'] as const)(
    'refuses inherited default launch environment before %s trust or claim',
    async (kind) => {
      const h = harness()
      h.settings.agentDefaultEnv = { codex: BOUND_ENV }
      const defaults = vi.spyOn(h.internal, 'resolveNewSessionOptions')
      const createTerminal = vi.spyOn(h.runtime, 'createTerminal')
      const operation =
        kind === 'create'
          ? h.runtime.createAgentSession({
              clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
              worktree: 'id:worktree-admission',
              agent: 'codex',
              prompt: 'test'
            })
          : h.runtime.ensureAgentSession({
              kind: 'explicit',
              worktree: 'id:worktree-admission',
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'provider-session' }
            })
      await expect(operation).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(defaults).not.toHaveBeenCalled()
      expect(createTerminal).not.toHaveBeenCalled()
      expect(h.trust).not.toHaveBeenCalled()
      expectNoLaunch(h)
    }
  )
})
