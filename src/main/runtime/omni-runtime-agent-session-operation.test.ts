import { describe, expect, it, vi } from 'vitest'
import type {
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './omni-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveNewAgentSessionDefaults } from './new-agent-session-defaults'
import { resolveNewAgentSessionCommandDefaults } from './new-agent-session-command-defaults'

function operationId(now = Date.now()): string {
  return `${now}-0123456789abcdef0123456789abcdef`
}

function request(
  clientOperationId: string,
  overrides: Partial<RuntimeCreateAgentSessionRequest> = {}
): RuntimeCreateAgentSessionRequest {
  return {
    clientOperationId,
    worktree: 'id:worktree-1',
    agent: 'codex',
    prompt: 'do the thing',
    presentation: 'background',
    ...overrides
  }
}

function terminal() {
  return {
    handle: 'term_operation',
    tabId: '11111111-1111-4111-8111-111111111111',
    paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-operation',
    worktreeId: 'worktree-1',
    title: null,
    surface: 'background' as const
  }
}

function createRuntime(
  provider?: {
    supportsAgentSessionClaims?: () => boolean
    supportsAgentSessionCreateOperations?: () => boolean
  },
  settings: Partial<GlobalSettings> = {}
) {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {},
        // Why: a saved choice keeps ledger tests off the runner's own Codex catalogue.
        nativeChatSessionOptions: { codex: { model: 'gpt-6.1-sol' } },
        ...settings
      })
    } as never,
    undefined,
    provider ? { getLocalProvider: () => provider as never } : undefined
  )
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
  }
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: 'worktree-1',
    path: '/tmp/worktree-1',
    connectionId: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.markRemoteWorkspaceTrustedForAgent = vi.fn()
  return runtime
}

describe('agent-session create operation ledger', () => {
  it('refreshes expired catalogue evidence through the selected host discovery path', async () => {
    const discoverModels = vi.fn(async () => [
      { id: 'gpt-6.1-sol', label: 'Sol', thinkingLevels: [{ id: 'medium', label: 'Medium' }] }
    ])
    const input = {
      agent: 'codex' as const,
      accountHome: '/owner/.codex',
      workspacePath: '/owner/project',
      readFile: async () => null,
      discoverModels
    }
    await expect(resolveNewAgentSessionDefaults(input)).resolves.toEqual({
      model: 'gpt-6.1-sol',
      effort: 'medium'
    })
    expect(discoverModels).toHaveBeenCalledExactlyOnceWith('/owner/.codex')
    await expect(
      resolveNewAgentSessionDefaults({ ...input, options: { model: 'explicit' } })
    ).resolves.toEqual({ model: 'explicit' })
    expect(discoverModels).toHaveBeenCalledTimes(1)
  })

  it('augments fresh managed prebuilt commands while preserving continuation and the sleeping command', async () => {
    const resolveDefaults = vi.fn(async () => ({ model: 'gpt-6.1-sol', effort: 'medium' }))
    const launchConfig = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    const input = {
      agent: 'codex' as const,
      command: "codex 'new prompt'",
      launchConfig,
      settings: {} as GlobalSettings,
      accountHome: '/accounts/selected/home',
      workspacePath: '/owner/project',
      resolveDefaults
    }
    const command = await resolveNewAgentSessionCommandDefaults(input)
    expect(command).toContain('gpt-6.1-sol')
    expect(command).toContain('medium')
    expect(command).toContain("'new prompt'")
    expect(launchConfig.agentCommand).toBe('codex')
    expect(resolveDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ accountHome: '/accounts/selected/home' })
    )
    resolveDefaults.mockClear()
    await expect(
      resolveNewAgentSessionCommandDefaults({ ...input, continuation: true })
    ).resolves.toBe(input.command)
    await expect(
      resolveNewAgentSessionCommandDefaults({
        ...input,
        command: "codex resume thread 'follow up'"
      })
    ).resolves.toBe("codex resume thread 'follow up'")
    for (const command of [
      'codex --resume=thread',
      'codex -p pinned-profile',
      "codex '--model' 'pinned-model'"
    ]) {
      await expect(resolveNewAgentSessionCommandDefaults({ ...input, command })).resolves.toBe(
        command
      )
    }
    for (const command of [
      'claude -r thread',
      'claude --resume=thread',
      'claude --continue=thread'
    ]) {
      await expect(
        resolveNewAgentSessionCommandDefaults({
          ...input,
          agent: 'claude',
          launchConfig: { ...launchConfig, agentCommand: 'claude' },
          command
        })
      ).resolves.toBe(command)
    }
    expect(resolveDefaults).not.toHaveBeenCalled()
  })

  it('applies Sol medium only with a fresh eligible catalogue and preserves model-only effort inheritance', async () => {
    const now = Date.parse('2026-09-30T12:00:00Z')
    const catalogue = JSON.stringify({
      fetched_at: new Date(now).toISOString(),
      models: [
        {
          slug: 'gpt-6.1-sol',
          display_name: 'Sol',
          supported_reasoning_levels: [{ effort: 'medium' }]
        }
      ]
    })
    const readFile = vi.fn(async (path: string) =>
      path.endsWith('models_cache.json') ? catalogue : null
    )
    const input = {
      agent: 'codex' as const,
      accountHome: '/owner/.codex',
      workspacePath: '/owner/project',
      readFile,
      now
    }
    await expect(resolveNewAgentSessionDefaults(input)).resolves.toEqual({
      model: 'gpt-6.1-sol',
      effort: 'medium'
    })
    readFile.mockClear()
    await expect(
      resolveNewAgentSessionDefaults({ ...input, options: { model: 'pinned-model' } })
    ).resolves.toEqual({ model: 'pinned-model' })
    expect(readFile).not.toHaveBeenCalled()
    await expect(
      resolveNewAgentSessionDefaults({ ...input, agentArgs: '--oss --local-provider ollama' })
    ).resolves.toBeUndefined()
    expect(readFile).not.toHaveBeenCalled()
    await expect(resolveNewAgentSessionDefaults({ ...input, now: now + 300_001 })).rejects.toThrow(
      'could not verify'
    )
  })

  it('preserves CLI-home pins and does not reinterpret provider configuration strings as pins', async () => {
    const input = {
      agent: 'claude' as const,
      accountHome: '/owner/.claude',
      workspacePath: '/owner/project',
      readFile: vi.fn(async () => '{"model":"sonnet","effortLevel":"high"}')
    }
    await expect(resolveNewAgentSessionDefaults(input)).resolves.toBeUndefined()
    await expect(
      resolveNewAgentSessionDefaults({ ...input, readFile: async () => '{}' })
    ).resolves.toEqual({ model: 'opus', effort: 'medium' })
    await expect(
      resolveNewAgentSessionDefaults({ ...input, readFile: async () => '{bad}' })
    ).rejects.toThrow()
    input.readFile.mockClear()
    await expect(
      resolveNewAgentSessionDefaults({
        ...input,
        env: { ANTHROPIC_MODEL: 'sonnet', CLAUDE_CODE_EFFORT_LEVEL: 'high' }
      })
    ).resolves.toBeUndefined()
    expect(input.readFile).not.toHaveBeenCalled()
  })

  it.each(['chat', 'terminal'] as const)(
    'preserves host model/account defaults with permission overrides scoped to %s',
    async (viewMode) => {
      const agentArgs = '--model host-model --sandbox read-only --ask-for-approval on-request'
      const runtime = createRuntime(undefined, {
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agentDefaultArgs: { codex: agentArgs },
        agentDefaultEnv: { codex: { CODEX_HOME: '/host/account' } }
      })
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

      await runtime.createAgentSession(request(operationId(), { viewMode }))

      const launch = createTerminal.mock.calls[0]![1]!
      expect(launch.env).toMatchObject({ CODEX_HOME: '/host/account' })
      expect(tokenizeStartupCommand(launch.launchConfig!.agentArgs!, 'posix')).toMatchObject({
        ok: true,
        tokens:
          viewMode === 'chat'
            ? ['--model', 'host-model', '--dangerously-bypass-approvals-and-sandbox']
            : [
                '--model',
                'host-model',
                '--sandbox',
                'read-only',
                '--ask-for-approval',
                'on-request'
              ]
      })
    }
  )

  it('selects legacy before trust, spawn, or ledger state for an old daemon', async () => {
    const provider = {
      supportsAgentSessionClaims: vi.fn(() => false),
      supportsAgentSessionCreateOperations: vi.fn(() => false)
    }
    const runtime = createRuntime(provider)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const internal = runtime as unknown as {
      markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    }
    const id = operationId()

    await expect(runtime.createAgentSession(request(id))).rejects.toThrow(
      'agent_session_legacy_required'
    )
    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
    expect(internal.markLocalWorkspaceTrustedForAgent).not.toHaveBeenCalled()

    provider.supportsAgentSessionCreateOperations.mockReturnValue(true)
    await expect(runtime.createAgentSession(request(id))).resolves.toMatchObject({
      disposition: 'created'
    })
    provider.supportsAgentSessionCreateOperations.mockReturnValue(false)
    await expect(runtime.createAgentSession(request(id))).resolves.toMatchObject({
      disposition: 'replayed'
    })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('requests exact client legacy fallback before nested SSH side effects', async () => {
    const runtime = createRuntime()
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1'
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'provider-session-1' }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('waits for Codex shell launch preparation before a structured resume', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await runtime.ensureAgentSession({
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'provider-session-1' }
    })

    expect(createTerminal).toHaveBeenCalledWith(
      'id:worktree-1',
      expect.objectContaining({
        command: expect.stringContaining("'resume' 'provider-session-1'"),
        startupCommandDelivery: 'shell-ready'
      })
    )
  })

  it('selects nested SSH legacy fallback before reading a Pi transcript path locally', async () => {
    const runtime = createRuntime()
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
      markRemoteWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope.mockResolvedValue({
      id: 'worktree-1',
      path: '/remote/worktree-1',
      connectionId: 'ssh-1'
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())

    await expect(
      runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'pi',
        providerSession: {
          key: 'session_id',
          id: 'provider-session-1',
          transcriptPath: '/remote-only/pi/session.jsonl'
        }
      })
    ).rejects.toThrow('agent_session_legacy_required')

    expect(createTerminal).not.toHaveBeenCalled()
    expect(internal.markRemoteWorkspaceTrustedForAgent).not.toHaveBeenCalled()
  })

  it('replays the same completed operation without spawning again', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'created' })
    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('records the template on create and still replays after it is removed', async () => {
    const settings: Partial<GlobalSettings> = {
      agentTemplates: { custom: [{ id: 'qa', name: 'QA', description: '', instructions: '# QA' }] }
    }
    const runtime = createRuntime(undefined, settings)
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await expect(
      runtime.createAgentSession(request(id, { agentTemplateId: 'qa' }), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal.mock.calls[0]?.[1]).toMatchObject({
      agentTemplate: { id: 'qa', name: 'QA' }
    })
    settings.agentTemplates = {}
    await expect(
      runtime.createAgentSession(request(id, { agentTemplateId: 'qa' }), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'replayed' })
    await expect(
      runtime.createAgentSession(request(operationId(Date.now() + 1), { agentTemplateId: 'qa' }), {
        clientId: 'device-a'
      })
    ).rejects.toThrow('Unknown agent template "qa"')
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('joins concurrent retries and conflicts on a changed fingerprint', async () => {
    const runtime = createRuntime()
    let finish!: (result: ReturnType<typeof terminal>) => void
    let markSpawnReady!: () => void
    const spawnReady = new Promise<void>((resolve) => {
      markSpawnReady = resolve
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
          markSpawnReady()
        })
    )
    const id = operationId()
    const first = runtime.createAgentSession(request(id), { clientId: 'device-a' })
    const joined = runtime.createAgentSession(request(id), { clientId: 'device-a' })

    await expect(
      runtime.createAgentSession(request(id, { prompt: 'changed' }), { clientId: 'device-a' })
    ).rejects.toThrow('agent_session_operation_conflict')
    await expect(
      runtime.createAgentSession(request(id, { agentArgs: '--profile changed' }), {
        clientId: 'device-a'
      })
    ).rejects.toThrow('agent_session_operation_conflict')
    await spawnReady
    finish(terminal())
    await expect(first).resolves.toMatchObject({ disposition: 'created' })
    await expect(joined).resolves.toMatchObject({ disposition: 'replayed' })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('isolates operation ids by authenticated caller', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()

    await runtime.createAgentSession(request(id), { clientId: 'device-a' })
    await runtime.createAgentSession(request(id), { clientId: 'device-b' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })

  it('rejects an expired unseen operation before terminal creation', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const expired = operationId(Date.now() - 25 * 60 * 60 * 1_000)

    await expect(
      runtime.createAgentSession(request(expired), { clientId: 'device-a' })
    ).rejects.toThrow('agent_session_operation_expired')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('releases a failed pre-spawn operation for a safe retry', async () => {
    const runtime = createRuntime()
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValueOnce(new Error('pre-spawn failure'))
      .mockResolvedValueOnce(terminal())
    const id = operationId()

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      'pre-spawn failure'
    )
    await expect(
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ).resolves.toMatchObject({ disposition: 'created' })
    expect(createTerminal).toHaveBeenCalledTimes(2)
    expect(createTerminal.mock.calls[0]?.[1]).toMatchObject({
      tabId: createTerminal.mock.calls[1]?.[1]?.tabId,
      leafId: createTerminal.mock.calls[1]?.[1]?.leafId,
      preAllocatedHandle: createTerminal.mock.calls[1]?.[1]?.preAllocatedHandle,
      agentSessionCreateOperationId:
        createTerminal.mock.calls[1]?.[1]?.agentSessionCreateOperationId
    })
    expect(createTerminal.mock.calls[0]?.[1]?.agentSessionCreateOperationId).toMatch(
      /^[A-Za-z0-9_-]{43}$/
    )
  })

  it.each([
    ['controller admission fails', 'agent_session_exited_during_start'],
    ['publication fails', 'post-spawn publication failure']
  ])('retains a replay fence when %s after physical spawn commit', async (_case, message) => {
    const runtime = createRuntime()
    const failure = new Error(message)
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (_worktree, opts) => {
        opts?.onPtySpawnCommitted?.()
        throw failure
      })
    const id = operationId()

    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('retains a replay fence when the provider reports an unknown spawn outcome', async () => {
    const runtime = createRuntime()
    const failure = Object.assign(new Error('cleanup could not prove exit'), {
      agentSessionOperationOutcome: 'unknown' as const
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockRejectedValue(failure)
    const id = operationId()

    const attempts: Promise<RuntimeCreateAgentSessionResult>[] = [
      runtime.createAgentSession(request(id), { clientId: 'device-a' }),
      runtime.createAgentSession(request(id), { clientId: 'device-a' })
    ]
    await expect(Promise.all(attempts)).rejects.toThrow(failure.message)
    await expect(runtime.createAgentSession(request(id), { clientId: 'device-a' })).rejects.toThrow(
      failure.message
    )
    expect(createTerminal).toHaveBeenCalledOnce()
  })
})
