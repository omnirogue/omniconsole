import { describe, expect, it, vi } from 'vitest'
import { classifyErrorMock, statSyncMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createProviderConversationFixture } from './pty-provider-conversation-fixture'
import { registerPtyHandlers, registerSshPtyProvider, unregisterSshPtyProvider } from './pty'
import * as provenance from '../launch-ledger/launch-provenance-guard'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { createMockMux } from '../providers/ssh-pty-provider-mock-multiplexer'
import { shutdownProviderAndDetectExit } from './pty/provider/shutdown-detect'

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

describe('main provider conversation ownership', () => {
  const suite = setupPtyIpcSuite()
  const { mainWindow } = suite
  const { setup, setupRuntime } = createProviderConversationFixture(suite)

  it('attaches a raw SSH session id through the real provider without another process', async () => {
    const h = setup()
    const connectionId = 'conn-1'
    const mux = createMockMux()
    let processCount = 0
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.spawn') {
        processCount++
        return { id: 'pty-1', incarnationId: 'ssh-incarnation' }
      }
      if (method === 'pty.attach') {
        return { incarnationId: 'ssh-incarnation' }
      }
      return undefined
    })
    const provider = new SshPtyProvider(connectionId, mux as never)
    registerSshPtyProvider(connectionId, provider)
    try {
      const first = await h.ipc({ connectionId })
      expect(provider.hasPty(first.id)).toBe(true)
      expect(provider.hasPty('pty-1')).toBe(false)
      await expect(h.ipc({ connectionId, sessionId: 'pty-1' })).resolves.toMatchObject({
        id: first.id,
        isReattach: true
      })
      expect(mux.request.mock.calls.filter(([method]) => method === 'pty.spawn')).toHaveLength(1)
      expect(mux.request.mock.calls.filter(([method]) => method === 'pty.attach')).toHaveLength(1)
      expect(processCount).toBe(1)
    } finally {
      unregisterSshPtyProvider(connectionId)
      provider.dispose()
    }
  })

  it('lets the following shutdown observer receive exit during mutable listener dispatch', async () => {
    const h = setup()
    const first = await h.ipc()
    h.provider.shutdown.mockImplementation(async () => {
      h.live.delete(first.id)
      for (const exit of h.exits) {
        exit({ id: first.id, code: 0, incarnationId: `incarnation-${first.id}` })
      }
    })
    await expect(
      shutdownProviderAndDetectExit(h.provider as never, first.id, { immediate: true })
    ).resolves.toBe(true)
    await h.ipc()
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.live.size).toBe(1)
  })

  it('releases failed-commit ownership and leaves retries to the base pipelines', async () => {
    for (const pipeline of ['renderer', 'runtime']) {
      const h = setup()
      const createProcess = vi.spyOn(h.live, 'add')
      let controller = h.controller
      const persistPtyBinding = vi.fn((): boolean => {
        throw new Error('disk full')
      })
      const registerPty = vi.fn()
      registerPtyHandlers(
        mainWindow as never,
        {
          setPtyController: (next: typeof controller) => {
            controller = next
          },
          createPreAllocatedTerminalHandle: vi.fn(() => 'term_failed_commit'),
          registerPreAllocatedHandleForPty: vi.fn(),
          registerPty
        } as never,
        undefined,
        undefined,
        undefined,
        { persistPtyBinding } as never
      )
      h.provider.shutdown.mockRejectedValue(new Error('shutdown failed'))
      const args = {
        ...h.args,
        worktreeId: 'wt-persistence',
        tabId: 'tab-persistence',
        leafId: '11111111-1111-4111-8111-111111111111',
        persistHostSessionBinding: true
      }
      const listeners = h.exits.length
      const launch = () => (pipeline === 'renderer' ? h.ipc(args) : controller.spawn(args))
      await expect(launch()).rejects.toThrow('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
      expect(h.provider.shutdown).toHaveBeenCalledTimes(1)
      expect(createProcess).toHaveBeenCalledTimes(1)
      expect(h.live.size).toBe(1)
      expect(registerPty).not.toHaveBeenCalled()
      expect(h.exits).toHaveLength(listeners)
      expect(args).not.toHaveProperty('sessionId')
      const survivingPtyId = [...h.live][0]
      persistPtyBinding.mockReturnValue(true)
      await expect(launch()).resolves.toBeDefined()
      expect(h.spawn).toHaveBeenCalledTimes(2)
      expect(h.spawn.mock.calls[1][0].sessionId).not.toBe(survivingPtyId)
      expect(h.spawn.mock.calls[1][0]).not.toHaveProperty('attachOnly', true)
      expect(createProcess).toHaveBeenCalledTimes(2)
      expect(h.live.size).toBe(2)
      expect(registerPty).toHaveBeenCalledTimes(1)
      expect(args).not.toHaveProperty('sessionId')
    }
  })

  it('refuses a different pane with the stable presentation marker', async () => {
    const h = setup()
    await h.ipc()
    await expect(h.ipc()).rejects.toMatchObject({
      code: 'agent_session_conflict',
      message: 'terminal_provider_conversation_running'
    })
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it.each(['renderer', 'runtime'])(
    'joins the same pane after %s physical spawn while commit is pending',
    async (pipeline) => {
      let joined: Promise<PromiseSettledResult<{ id: string }>[]> | undefined
      const h = setup({
        registerPreAllocatedHandleForPty: vi.fn(() => {
          joined = Promise.allSettled([h.ipc(args)])
        })
      })
      const args = {
        ...h.args,
        worktreeId: 'wt-commit-join',
        tabId: 'tab-commit-join',
        leafId: '11111111-1111-4111-8111-111111111111',
        preAllocatedHandle: 'term_commit_join',
        persistHostSessionBinding: false
      }
      const first = await (pipeline === 'renderer' ? h.ipc(args) : h.controller.spawn(args))
      expect(joined).toBeDefined()
      expect(await joined).toEqual([{ status: 'fulfilled', value: expect.objectContaining(first) }])
      expect(h.spawn).toHaveBeenCalledTimes(1)
      expect(h.live.size).toBe(1)
    }
  )

  it.each(['renderer', 'runtime'])(
    'does not reserve a dropped Codex resume after a fresh %s launch',
    async (pipeline) => {
      const h = setup()
      let controller = h.controller
      const prepareResume = vi.fn(async () => ({
        outcome: 'fresh' as const,
        claimedCodexProvenance: false
      }))
      registerPtyHandlers(
        mainWindow as never,
        {
          setPtyController: (next: typeof controller) => {
            controller = next
          },
          createPreAllocatedTerminalHandle: vi.fn(() => 'term_fresh_fallback'),
          registerPreAllocatedHandleForPty: vi.fn(),
          registerPty: vi.fn()
        } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        { prepareCodexSessionResume: prepareResume }
      )
      const args = {
        ...h.args,
        launchAgent: 'codex',
        command: `codex resume ${h.conversation}`,
        resumeProviderSession: {
          key: 'session_id',
          id: h.conversation,
          transcriptPath: '/tmp/other-agent.jsonl'
        }
      }
      const launch = () =>
        pipeline === 'renderer'
          ? h.ipc(args)
          : controller.spawn({ ...args, persistHostSessionBinding: false })
      const listeners = h.exits.length
      await launch()
      expect(h.spawn.mock.calls[0][0].command).not.toContain('resume')
      expect(h.exits).toHaveLength(listeners)
      prepareResume.mockResolvedValueOnce(null as never)
      await expect(launch()).resolves.toBeDefined()
      expect(h.spawn).toHaveBeenCalledTimes(2)
      expect(h.live.size).toBe(2)
    }
  )

  it('starts one process for concurrent renderer resumes from different panes', async () => {
    const h = setup()
    const pane = { worktreeId: 'wt-concurrent', leafId: '11111111-1111-4111-8111-111111111111' }
    const results = await Promise.allSettled([
      h.ipc({ ...pane, tabId: 'first-pane' }),
      h.ipc({ ...pane, tabId: 'second-pane' })
    ])
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    ).toMatchObject({ code: 'agent_session_conflict' })
  })

  it('starts one process for concurrent runtime and renderer resumes', async () => {
    const h = setup()
    const results = await Promise.allSettled([h.controller.spawn(h.args), h.ipc()])
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('connects the real runtime ensure path to the renderer resume guard', async () => {
    const h = setup()
    const { runtime, create } = setupRuntime(h)
    const request = {
      kind: 'explicit' as const,
      worktree: 'id:workspace',
      agent: 'claude' as const,
      providerSession: h.args.resumeProviderSession as never
    }
    const first = await runtime.ensureAgentSession(request)
    const listeners = h.exits.length
    const adopted = await runtime.ensureAgentSession(request)
    expect(h.exits.length).toBe(listeners)
    expect(adopted.disposition).toBe('adopted')
    expect(adopted.terminal.ptyId).toBe(first.terminal.ptyId)
    expect(create).toHaveBeenCalledTimes(2)
    const duplicate = await Promise.allSettled([h.ipc()])
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(duplicate[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'agent_session_conflict' }
    })
  })

  it('joins concurrent real runtime ensure requests and returns the adopted terminal', async () => {
    const h = setup()
    const { runtime } = setupRuntime(h)
    const request = {
      kind: 'explicit' as const,
      worktree: 'id:workspace',
      agent: 'claude' as const,
      providerSession: h.args.resumeProviderSession as never
    }
    const results = await Promise.allSettled([
      runtime.ensureAgentSession(request),
      runtime.ensureAgentSession(request)
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    const successful = results.map(
      (r) =>
        (r as PromiseFulfilledResult<Awaited<ReturnType<typeof runtime.ensureAgentSession>>>).value
    )
    expect(successful.map((r) => r.disposition).sort()).toEqual(['adopted', 'created'])
    expect(successful[1].terminal.ptyId).toBe(successful[0].terminal.ptyId)
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it.each(['renderer', 'runtime'])(
    'joins a pending %s spawn for the same pane',
    async (pipeline) => {
      const h = setup()
      const args = {
        ...h.args,
        worktreeId: 'wt-join',
        tabId: 'tab-join',
        leafId: '11111111-1111-4111-8111-111111111111',
        persistHostSessionBinding: false
      }
      let finish!: () => void
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        finish = resolve
      })
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const spawn = h.spawn.getMockImplementation()!
      h.spawn.mockImplementation(async (options) => {
        entered()
        await waiting
        return spawn(options)
      })
      const first = pipeline === 'renderer' ? h.ipc(args) : h.controller.spawn(args)
      await started
      const joined = Promise.allSettled([first, h.ipc(args)])
      await Promise.resolve()
      finish()
      const results = await joined
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
      expect((results[1] as PromiseFulfilledResult<unknown>).value).toMatchObject({
        id: (results[0] as PromiseFulfilledResult<{ id: string }>).value.id,
        isReattach: true
      })
      expect(h.spawn).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['renderer', 'runtime'])(
    'starts Claude fallback B when requested identity A is already alive in the %s pipeline',
    async (pipeline) => {
      const h = setup()
      const fallback = h.conversation.replace('conversation-', 'fallback-')
      const transcript = `/tmp/${h.conversation}.jsonl`
      const fallbackTranscript = `/tmp/${fallback}.jsonl`
      let originalExists = true
      statSyncMock.mockImplementation((path) => ({
        isFile: () => path === fallbackTranscript || (originalExists && path === transcript)
      }))
      const launch = (providerSession: Record<string, unknown>) => {
        const args = {
          ...h.args,
          resumeProviderSession: providerSession,
          persistHostSessionBinding: false
        }
        return pipeline === 'renderer' ? h.ipc(args) : h.controller.spawn(args)
      }
      await launch({ key: 'session_id', id: h.conversation, transcriptPath: transcript })
      originalExists = false
      await expect(
        launch({
          key: 'session_id',
          id: h.conversation,
          transcriptPath: transcript,
          verifiedFallback: { key: 'session_id', id: fallback, transcriptPath: fallbackTranscript }
        })
      ).resolves.toBeDefined()
      expect(h.spawn).toHaveBeenCalledTimes(2)
      expect(h.live.size).toBe(2)
      expect(h.spawn.mock.calls.map(([options]) => options.command)).toEqual([
        `claude --resume ${h.conversation}`,
        expect.stringContaining(fallback)
      ])
    }
  )

  it.each(['renderer', 'runtime'])(
    'does not guard metadata whose final %s command has no resume identity',
    async (pipeline) => {
      const h = setup()
      await h.ipc()
      const args = { ...h.args, command: 'claude', persistHostSessionBinding: false }
      const listeners = h.exits.length
      await expect(
        pipeline === 'renderer' ? h.ipc(args) : h.controller.spawn(args)
      ).resolves.toBeDefined()
      expect(h.spawn).toHaveBeenCalledTimes(2)
      expect(h.live.size).toBe(2)
      expect(h.exits).toHaveLength(listeners)
    }
  )

  it.each(['renderer', 'runtime'])(
    'tracks Claude fallback identity in the %s pipeline',
    async (pipeline) => {
      const h = setup()
      const fallback = h.conversation.replace('conversation-', 'fallback-')
      const transcript = `/tmp/${h.conversation}.jsonl`
      const fallbackTranscript = `/tmp/${fallback}.jsonl`
      let restored = false
      statSyncMock.mockImplementation((path) => ({
        isFile: () => path === fallbackTranscript || (restored && path === transcript)
      }))
      const launch = (id: string, providerSession: Record<string, unknown>) => {
        const args = {
          ...h.args,
          command: `claude --resume ${id}`,
          resumeProviderSession: providerSession,
          persistHostSessionBinding: false
        }
        return pipeline === 'renderer' ? h.ipc(args) : h.controller.spawn(args)
      }
      await launch(h.conversation, {
        key: 'session_id',
        id: h.conversation,
        transcriptPath: transcript,
        verifiedFallback: { key: 'session_id', id: fallback, transcriptPath: fallbackTranscript }
      })
      await expect(
        launch(fallback, { key: 'session_id', id: fallback, transcriptPath: fallbackTranscript })
      ).rejects.toThrow('terminal_provider_conversation_running')
      expect(h.spawn).toHaveBeenCalledTimes(1)
      restored = true
      await expect(
        launch(h.conversation, {
          key: 'session_id',
          id: h.conversation,
          transcriptPath: transcript
        })
      ).resolves.toBeDefined()
      expect(h.spawn).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['renderer', 'runtime'])(
    'refuses Claude fallback to an already live owner in the %s pipeline',
    async (pipeline) => {
      const h = setup()
      const transcript = `/tmp/${h.conversation}.jsonl`
      statSyncMock.mockImplementation((path) => ({ isFile: () => path === transcript }))
      const launch = (args: Record<string, unknown>) =>
        pipeline === 'renderer'
          ? h.ipc(args)
          : h.controller.spawn({ ...h.args, ...args, persistHostSessionBinding: false })
      await launch({
        resumeProviderSession: { key: 'session_id', id: h.conversation, transcriptPath: transcript }
      })
      await expect(
        launch({
          command: `claude --resume ${h.conversation}-missing`,
          resumeProviderSession: {
            key: 'session_id',
            id: `${h.conversation}-missing`,
            transcriptPath: '/tmp/missing.jsonl',
            verifiedFallback: { key: 'session_id', id: h.conversation, transcriptPath: transcript }
          }
        })
      ).rejects.toThrow('terminal_provider_conversation_running')
      expect(h.spawn).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['renderer', 'runtime'])(
    'releases failed and exited %s reservations when provenance callbacks are skipped',
    async (pipeline) => {
      const skipped = vi
        .spyOn(provenance, 'attemptLaunchProvenance')
        .mockImplementation((_scope, _run, fallback) => fallback)
      try {
        const h = setup()
        const launch = () =>
          pipeline === 'renderer'
            ? h.ipc()
            : (h.controller.spawn(h.args) as Promise<{ id: string }>)
        classifyErrorMock.mockReturnValueOnce({ error_class: 'unknown', retryable: false })
        h.spawn.mockRejectedValueOnce(new Error('provider unavailable'))
        await expect(launch()).rejects.toThrow('provider unavailable')
        const first = await launch()
        await expect(launch()).rejects.toThrow('terminal_provider_conversation_running')
        expect(h.spawn).toHaveBeenCalledTimes(2)
        expect(h.live.size).toBe(1)
        h.live.delete(first.id)
        h.exits.forEach((exit) =>
          exit({ id: first.id, code: 0, incarnationId: `incarnation-${first.id}` })
        )
        await launch()
        expect(h.spawn).toHaveBeenCalledTimes(3)
        expect(h.live.size).toBe(1)
        expect(skipped).toHaveBeenCalled()
      } finally {
        skipped.mockRestore()
      }
    }
  )

  it('starts exactly one replacement after the owner exits', async () => {
    const h = setup()
    const first = await h.ipc()
    h.live.delete(first.id)
    h.exits.forEach((exit) =>
      exit({ id: first.id, code: 0, incarnationId: `incarnation-${first.id}` })
    )
    await h.ipc()
    expect(h.spawn).toHaveBeenCalledTimes(2)
  })

  it.each(['null', 'rejected', 'false', 'rejected promise'])(
    'fails open for a %s owner probe',
    async (verdict) => {
      const h = setup()
      await h.ipc()
      h.provider.hasPty.mockImplementation(() => {
        if (verdict === 'rejected') {
          throw new Error('contact lost')
        }
        if (verdict === 'rejected promise') {
          return Promise.reject(new Error('contact lost'))
        }
        return verdict === 'null' ? null : false
      })
      await h.ipc()
      expect(h.spawn).toHaveBeenCalledTimes(2)
    }
  )

  it('does not let a stale exit callback remove the replacement owner', async () => {
    const h = setup()
    const first = await h.ipc()
    const oldCallbacks = [...h.exits]
    h.provider.hasPty.mockReturnValueOnce(null)
    await h.ipc()
    oldCallbacks.forEach((exit) => exit({ id: first.id, code: 0 }))
    const duplicate = await Promise.allSettled([h.ipc()])
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(duplicate[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'agent_session_conflict' }
    })
  })

  it('ignores an old incarnation exit after the PTY id is reused', async () => {
    const h = setup()
    const first = await h.ipc()
    h.provider.hasPty.mockReturnValueOnce(null)
    h.spawn.mockResolvedValueOnce({ id: first.id, incarnationId: 'replacement-incarnation' })
    await h.ipc()
    h.exits.forEach((exit) =>
      exit({ id: first.id, code: 0, incarnationId: `incarnation-${first.id}` })
    )
    const duplicate = await Promise.allSettled([h.ipc()])
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(duplicate[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'agent_session_conflict' }
    })
  })

  it('ignores delayed unknown probe results without erasing the new owner', async () => {
    const h = setup()
    await h.ipc()
    let reply!: (value: boolean) => void
    h.provider.hasPty.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        reply = resolve
      })
    )
    await h.ipc()
    reply(false)
    await Promise.resolve()
    const duplicate = await Promise.allSettled([h.ipc()])
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(duplicate[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'agent_session_conflict' }
    })
  })

  it('releases a failed launch so a retry starts exactly one process', async () => {
    const h = setup()
    classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
    h.spawn.mockRejectedValueOnce(new Error('spawn failed'))
    await expect(h.ipc()).rejects.toThrow('spawn failed')
    await h.ipc()
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.live.size).toBe(1)
  })

  it('leaves named live attachment available', async () => {
    const h = setup()
    const first = await h.ipc()
    h.provider.attach.mockResolvedValue({ id: first.id, isReattach: true })
    await expect(h.ipc({ sessionId: first.id })).resolves.toMatchObject({
      id: first.id,
      isReattach: true
    })
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.live.size).toBe(1)
  })

  it('preserves implicit attachment to the same live stable pane', async () => {
    const resolveTerminalPane = vi.fn(() => {
      throw new Error('terminal_not_found')
    })
    const h = setup({ resolveTerminalPane })
    const pane = {
      worktreeId: 'workspace',
      tabId: '11111111-1111-4111-8111-111111111111',
      leafId: '22222222-2222-4222-8222-222222222222'
    }
    const first = await h.ipc(pane)
    resolveTerminalPane.mockReturnValue({
      ...pane,
      ptyId: first.id,
      handle: 'term_owner',
      connected: true
    } as never)
    h.spawn.mockResolvedValueOnce({
      id: first.id,
      isReattach: true,
      incarnationId: `incarnation-${first.id}`
    })
    await expect(h.ipc(pane)).resolves.toMatchObject({ id: first.id, isReattach: true })
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(h.live.size).toBe(1)
  })

  it.each(['pi', 'prime-agent', 'omp'])('does not track %s file resumes', async (agent) => {
    const h = setup()
    const overrides = {
      launchAgent: agent,
      command: `${agent} --resume /tmp/session.jsonl`,
      launchConfig: { agentCommand: agent, agentArgs: '--resume /tmp/session.jsonl', agentEnv: {} },
      resumeProviderSession: undefined
    }
    await h.ipc(overrides)
    await h.ipc(overrides)
    expect(h.spawn).toHaveBeenCalledTimes(2)
  })

  it('preserves fresh launches and different conversations', async () => {
    const h = setup()
    await h.ipc()
    await h.ipc({
      command: `claude --resume different-${h.conversation}`,
      resumeProviderSession: { key: 'session_id', id: `different-${h.conversation}` }
    })
    await h.ipc({ resumeProviderSession: undefined, command: 'claude' })
    await h.ipc({ resumeProviderSession: undefined, command: 'claude' })
    expect(h.spawn).toHaveBeenCalledTimes(4)
  })
})
