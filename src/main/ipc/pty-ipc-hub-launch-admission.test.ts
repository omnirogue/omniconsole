import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { registerPtyHandlers } from './pty'
import { paneSpawnReservationsByOwnerKey } from './pty/pane/spawn-reservation'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  classifyErrorMock,
  openCodeBuildPtyEnvMock,
  writeFileSyncMock
} from './pty-ipc-mock-registry'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-omni-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('IPC Hub terminal launch admission', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const leafId = '88888888-8888-4888-8888-888888888888'
  const args = {
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    worktreeId: 'repo::/tmp',
    tabId: 'tab-hub-admission',
    leafId
  }

  function fixture() {
    classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
    const spawn = installDaemonTestProvider()
    const release = vi.fn()
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-hub-admission'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      acquireWorktreeTerminalSpawn: vi.fn(async () => release),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    const auth = { configDir: '/tmp/claude', envPatch: {}, stripAuthEnv: false, provenance: 'test' }
    const prepareAuth = vi.fn(async () => auth)
    const store = {
      getWorktreeMeta: vi.fn(() => ({})),
      getFolderWorkspaces: vi.fn(() => []),
      getFolderWorkspace: vi.fn(() => ({ id: 'linked-folder', folderPath: '/tmp' })),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => []),
      persistPtyBinding: vi.fn()
    }
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      prepareAuth,
      store as never
    )
    return { spawn, runtime, store, prepareAuth, auth, release }
  }

  it.each([
    { env: { OMNI_TASK_ID: 'btk_explicit' } },
    { launchConfig: { agentCommand: 'claude', agentEnv: { OMNI_TASK_ID: 'btk_captured' } } }
  ])(
    'rejects explicit binding before auth, reservation, locks, or host writes: %j',
    async (binding) => {
      const { spawn, runtime, prepareAuth } = fixture()
      await expect(
        handlers.get('pty:spawn')!(null, { ...args, command: 'claude', ...binding })
      ).rejects.toMatchObject({ code: 'consumer_fenced' })
      expect(prepareAuth).not.toHaveBeenCalled()
      expect(runtime.acquireWorktreeTerminalSpawn).not.toHaveBeenCalled()
      expect(runtime.createPreAllocatedTerminalHandle).not.toHaveBeenCalled()
      expect(openCodeBuildPtyEnvMock).not.toHaveBeenCalled()
      expect(writeFileSyncMock).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
    }
  )

  it('rechecks the merged auth environment after awaiting auth preparation', async () => {
    const { spawn, prepareAuth, auth } = fixture()
    let releaseAuth!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseAuth = resolve
    })
    prepareAuth.mockImplementation(async () => {
      await barrier
      return { ...auth, envPatch: { OMNI_TASK_ID: 'btk_auth_merge' } }
    })
    const pending = handlers.get('pty:spawn')!(null, { ...args, command: 'claude' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'consumer_fenced' })
    await vi.waitFor(() => expect(prepareAuth).toHaveBeenCalledOnce())
    releaseAuth()
    await rejected
    expect(spawn).not.toHaveBeenCalled()
    expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
  })

  it('rejects binding introduced by assembled host environment', async () => {
    const { spawn } = fixture()
    openCodeBuildPtyEnvMock.mockReturnValue({ OMNI_TASK_ID: 'btk_host_overlay' })
    await expect(handlers.get('pty:spawn')!(null, args)).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rechecks declared agent workspace binding after the spawn lock wait', async () => {
    const { spawn, runtime, store, release } = fixture()
    runtime.acquireWorktreeTerminalSpawn.mockImplementation(async () => {
      store.getWorktreeMeta.mockReturnValue({ linkedWorkItem: { hubTaskId: 'btk_admitted' } })
      return release
    })
    await expect(
      handlers.get('pty:spawn')!(null, { ...args, launchAgent: 'claude', command: 'claude' })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(spawn).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('rejects a declared agent in a linked folder while allowing an ordinary shell', async () => {
    const { spawn, store, prepareAuth } = fixture()
    store.getFolderWorkspaces.mockReturnValue([
      { id: 'linked-folder', folderPath: '/tmp', linkedTask: { hubTaskId: 'btk_folder' } }
    ] as never)
    const folderArgs = { ...args, worktreeId: 'folder:linked-folder' }
    await expect(
      handlers.get('pty:spawn')!(null, { ...folderArgs, launchAgent: 'claude', command: 'claude' })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(prepareAuth).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    store.getWorktreeMeta.mockReturnValue({ linkedWorkItem: { hubTaskId: 'btk_shell_workspace' } })
    await expect(handlers.get('pty:spawn')!(null, folderArgs)).resolves.toHaveProperty('id')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('allows a command-only canonical gate without provider Hub environment', async () => {
    const { spawn } = fixture()
    await expect(
      handlers.get('pty:spawn')!(null, {
        ...args,
        command: 'python -I -S gate.py',
        env: { PYTHONPATH: '' }
      })
    ).resolves.toHaveProperty('id')
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('reattaches an exact caller session with a Hub env without fresh launch flags', async () => {
    const { spawn } = fixture()
    spawn.mockResolvedValue({
      id: 'existing-session',
      incarnationId: 'existing-inc',
      isReattach: true
    })
    await expect(
      handlers.get('pty:spawn')!(null, {
        ...args,
        sessionId: 'existing-session',
        env: { OMNI_TASK_ID: 'btk_live' },
        command: 'claude',
        commandDelivery: 'provider',
        launchAgent: 'claude'
      })
    ).resolves.toMatchObject({ id: 'existing-session', isReattach: true })
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      attachOnly: true,
      command: undefined,
      commandDelivery: undefined,
      launchAgent: undefined
    })
  })

  it.each([
    [new SessionNotFoundError('existing-session'), { code: 'consumer_fenced' }],
    [new Error('connection unavailable'), { message: 'connection unavailable' }]
  ])(
    'never falls back to fresh launch after a fenced caller attach fails: %s',
    async (error, expected) => {
      const { spawn } = fixture()
      spawn.mockRejectedValue(error)
      await expect(
        handlers.get('pty:spawn')!(null, {
          ...args,
          sessionId: 'existing-session',
          env: { OMNI_TASK_ID: 'btk_live' }
        })
      ).rejects.toMatchObject(expected)
      expect(spawn).toHaveBeenCalledOnce()
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
    }
  )

  it.each([
    { id: 'replacement-session', isReattach: true },
    { id: 'existing-session', isReattach: false }
  ])('rejects an inexact fenced session attachment: %j', async (result) => {
    const { spawn } = fixture()
    spawn.mockResolvedValue(result)
    await expect(
      handlers.get('pty:spawn')!(null, {
        ...args,
        sessionId: 'existing-session',
        env: { OMNI_TASK_ID: 'btk_live' }
      })
    ).rejects.toThrow('terminal_pane_owner_changed')
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
  })

  it('fences a replacement when a stable Hub pane disappears during attachment', async () => {
    const { spawn, runtime, prepareAuth } = fixture()
    runtime.resolveTerminalPane.mockReturnValue({
      handle: 'term-existing',
      tabId: args.tabId,
      leafId,
      ptyId: 'existing-pane',
      worktreeId: args.worktreeId
    } as never)
    spawn.mockImplementation(async () => {
      runtime.resolveTerminalPane.mockImplementation(() => {
        throw new Error('terminal_not_found')
      })
      throw new SessionNotFoundError('existing-pane')
    })
    await expect(
      handlers.get('pty:spawn')!(null, {
        ...args,
        command: 'claude',
        env: { OMNI_TASK_ID: 'btk_live' }
      })
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(prepareAuth).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
  })

  it('adopts an existing stable Hub pane before replacement launch preparation', async () => {
    const { spawn, runtime, prepareAuth } = fixture()
    runtime.resolveTerminalPane.mockReturnValue({
      handle: 'term-existing',
      tabId: args.tabId,
      leafId,
      ptyId: 'existing-pane',
      worktreeId: args.worktreeId
    } as never)
    spawn.mockResolvedValue({
      id: 'existing-pane',
      incarnationId: 'existing-inc',
      isReattach: true
    })
    await expect(
      handlers.get('pty:spawn')!(null, {
        ...args,
        launchAgent: 'claude',
        command: 'claude',
        env: { OMNI_TASK_ID: 'btk_live', ORCA_PANE_KEY: makePaneKey(args.tabId, leafId) }
      })
    ).resolves.toMatchObject({ id: 'existing-pane', isReattach: true })
    expect(prepareAuth).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true, command: undefined })
  })
})
