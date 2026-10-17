import { describe, expect, it, vi } from 'vitest'
import { getAgentHookStatusSnapshotMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createProviderConversationFixture } from './pty-provider-conversation-fixture'
import { registerPtyHandlers } from './pty'
import { clearProviderPtyState } from './pty/provider/state-cleanup'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'

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

describe('provider conversation owners that predate this app process', () => {
  const suite = setupPtyIpcSuite()
  const { mainWindow } = suite
  const { setup, setupRuntime, settings } = createProviderConversationFixture(suite)

  const TAB = '33333333-3333-4333-8333-333333333333'
  const LEAF = '44444444-4444-4444-8444-444444444444'
  const PANE = `${TAB}:${LEAF}`
  const PRIOR = 'pty-before-restart'
  const PRIOR_INCARNATION = 'incarnation-before-restart'

  /** A pane that resumed the conversation before this process started; its PTY still runs in
   *  the daemon, which only the host listing knows (this process never attached it). */
  function setupSaved(
    h: ReturnType<typeof setup>,
    source: 'sleeping record' | 'hook row' | 'both',
    saved: {
      persistedIncarnationId?: string
      listedIncarnationId?: string
      foreground?: string | null
      owners?: AgentSessionOwnerBinding[]
    } = {}
  ) {
    const providerSession = { key: 'session_id', id: h.conversation }
    const state = {
      tabsByWorktree: { workspace: [{ id: TAB, worktreeId: 'workspace', ptyId: PRIOR }] },
      terminalLayoutsByTabId: { [TAB]: { ptyIdsByLeafId: { [LEAF]: PRIOR } } },
      terminalPtyIncarnationsByPaneKey: saved.persistedIncarnationId
        ? { [PANE]: saved.persistedIncarnationId }
        : {},
      sleepingAgentSessionsByPaneKey:
        source === 'hook row'
          ? {}
          : {
              [PANE]: {
                paneKey: PANE,
                worktreeId: 'workspace',
                agent: 'claude',
                providerSession,
                state: 'done',
                prompt: '',
                capturedAt: 0,
                updatedAt: 0
              }
            }
    }
    getAgentHookStatusSnapshotMock.mockReturnValue(
      source === 'sleeping record'
        ? []
        : [
            {
              paneKey: PANE,
              connectionId: null,
              agentType: 'claude',
              providerSession,
              state: 'done',
              receivedAt: 0,
              stateStartedAt: 0
            }
          ]
    )
    h.provider.listProcesses.mockImplementation(async () => [
      {
        id: PRIOR,
        incarnationId: saved.listedIncarnationId ?? PRIOR_INCARNATION,
        cwd: '/tmp/workspace',
        title: 'claude',
        ...(saved.owners ? { agentSessionOwners: saved.owners } : {})
      },
      ...[...h.live].map((id) => ({
        id,
        incarnationId: `incarnation-${id}`,
        cwd: '/tmp/workspace',
        title: 'claude'
      }))
    ])
    h.provider.getForegroundProcess.mockResolvedValue(
      saved.foreground === undefined ? 'claude' : saved.foreground
    )
    const store = {
      getSettings: settings,
      getWorkspaceSession: () => state,
      persistPtyBinding: () => true
    }
    let controller = h.controller
    registerPtyHandlers(
      mainWindow as never,
      {
        setPtyController: (next: typeof controller) => {
          controller = next
        },
        createPreAllocatedTerminalHandle: vi.fn(() => 'term_saved_owner'),
        registerPreAllocatedHandleForPty: vi.fn(),
        registerPty: vi.fn(),
        onPtyExit: vi.fn()
      } as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    return { store, controller: () => controller }
  }

  it.each(['sleeping record', 'hook row', 'both'] as const)(
    'starts no second process for a conversation whose %s names a listed pre-restart owner',
    async (source) => {
      const h = setup()
      const saved = setupSaved(h, source)
      expect(h.provider.hasPty(PRIOR)).toBe(false)
      const { runtime } = setupRuntime(h, saved.controller(), saved.store)
      // A paired device resuming the conversation (terminal.ensureAgentSession).
      await expect(
        runtime.ensureAgentSession(
          {
            kind: 'explicit',
            worktree: 'id:workspace',
            agent: 'claude',
            providerSession: h.args.resumeProviderSession as never
          },
          { clientKind: 'runtime' }
        )
      ).rejects.toThrow('agent_session_conflict')
      // A paired device creating a terminal whose command resumes it (terminal.create).
      await expect(
        runtime.createTerminal('id:workspace', {
          command: `claude --resume ${h.conversation}`,
          launchAgent: 'claude'
        })
      ).rejects.toThrow('terminal_provider_conversation_running')
      // A renderer pane resuming it.
      await expect(h.ipc()).rejects.toMatchObject({
        code: 'agent_session_conflict',
        message: 'terminal_provider_conversation_running'
      })
      expect(h.spawn).not.toHaveBeenCalled()
      expect(h.live.size).toBe(0)
    }
  )

  it('lets the owning pane reattach to its pre-restart process', async () => {
    const h = setup()
    setupSaved(h, 'both')
    h.spawn.mockImplementationOnce(async (options) => ({
      id: options.sessionId as string,
      isReattach: true
    }))
    await expect(
      h.ipc({ worktreeId: 'workspace', tabId: TAB, leafId: LEAF })
    ).resolves.toMatchObject({ id: PRIOR, isReattach: true })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.spawn.mock.calls[0][0]).toMatchObject({ sessionId: PRIOR, attachOnly: true })
  })

  it('adopts a pre-restart owner the host lists under the same structured claim', async () => {
    const h = setup()
    const claim = {
      digestVersion: 1 as const,
      keyId: 'claim-key',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      agent: 'claude' as const
    }
    const surface = { worktreeId: 'workspace', tabId: TAB, leafId: LEAF, terminalHandle: 'term_x' }
    const owner: AgentSessionOwnerBinding = {
      claim,
      generation: 'generation-before-restart',
      phase: 'live',
      ptyId: PRIOR,
      surface
    }
    const saved = setupSaved(h, 'both', { owners: [owner] })
    h.provider.providesAgentSessionOwnerListings.mockReturnValue(true)
    try {
      await expect(
        saved.controller().spawn({
          ...h.args,
          agentSessionEnsure: { claim, surface },
          persistHostSessionBinding: false
        })
      ).resolves.toMatchObject({ id: PRIOR, agentSessionEnsure: { disposition: 'adopted' } })
      expect(h.spawn).not.toHaveBeenCalled()
    } finally {
      clearProviderPtyState(PRIOR)
    }
  })

  it('starts exactly one process once the host no longer lists the pre-restart owner', async () => {
    const h = setup()
    setupSaved(h, 'both')
    h.provider.listProcesses.mockImplementation(async () =>
      [...h.live].map((id) => ({ id, incarnationId: `incarnation-${id}` }))
    )
    await h.ipc()
    await expect(h.ipc()).rejects.toThrow('terminal_provider_conversation_running')
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.live.size).toBe(1)
  })

  it.each([
    ['the host listing is unavailable', {}, true],
    ['the saved pane now runs a shell', { foreground: 'zsh' }, false],
    [
      'the PTY id was reused by a newer incarnation',
      {
        persistedIncarnationId: 'incarnation-older',
        listedIncarnationId: 'incarnation-newer',
        foreground: null
      },
      false
    ]
  ] as const)('fails open when %s', async (_name, saved, listingUnavailable) => {
    const h = setup()
    setupSaved(h, 'both', saved)
    if (listingUnavailable) {
      h.provider.listProcesses.mockRejectedValue(new Error('daemon unreachable'))
    }
    await expect(h.ipc()).resolves.toBeDefined()
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('still refuses when the saved foreground cannot be read', async () => {
    const h = setup()
    setupSaved(h, 'both', { foreground: null })
    await expect(h.ipc()).rejects.toThrow('terminal_provider_conversation_running')
    expect(h.spawn).not.toHaveBeenCalled()
  })
})
