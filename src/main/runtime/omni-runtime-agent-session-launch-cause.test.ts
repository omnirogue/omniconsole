import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import { OrcaRuntimeService } from './omni-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'

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

describe('agent session launch cause propagation', () => {
  it('passes the caller cause to createTerminal with clientOperationId as requestId', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const id = operationId()
    const launchCause = {
      trigger: 'agent-session-create',
      actor: {
        kind: 'paired-device',
        deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        clientKind: 'runtime'
      }
    }
    await runtime.createAgentSession(request(id), {
      clientId: 'bearer-secret',
      launchCause
    } as never)
    expect(
      (createTerminal.mock.calls[0]?.[1] as unknown as { launchCause: unknown })?.launchCause
    ).toEqual({
      ...launchCause,
      clientMutationIdHash: createHash('sha256').update(id).digest('hex')
    })
  })
  it('passes a resume caller cause to createTerminal', async () => {
    const runtime = createRuntime()
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
    const launchCause = {
      trigger: 'agent-session-resume',
      actor: { kind: 'local-cli' },
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    }
    await runtime.ensureAgentSession(
      {
        kind: 'explicit',
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session-1' }
      },
      { launchCause } as never
    )
    expect(
      (createTerminal.mock.calls[0]?.[1] as unknown as { launchCause: unknown })?.launchCause
    ).toEqual(launchCause)
  })

  it.each(['hibernation-wake', 'session-resume', 'agent-session-resume'] as const)(
    'applies only the managed wake updater override while preserving the %s cause and resume',
    async (trigger) => {
      const settings: Partial<GlobalSettings> = {
        agentDefaultArgs: {
          codex:
            '-c check_for_update_on_startup=true --config features.web_search=true -c model_reasoning_effort=low'
        },
        agentDefaultEnv: { codex: { CODEX_HOME: '/verified/worker/account' } }
      }
      const before = structuredClone(settings)
      const runtime = createRuntime(undefined, settings)
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue(terminal())
      const launchCause = { trigger, actor: { kind: 'app' as const } }
      await runtime.ensureAgentSession(
        {
          kind: 'explicit',
          worktree: 'id:worktree-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          launchPreferences: { model: 'gpt-6.1-sol', effort: 'high' }
        },
        { launchCause }
      )
      const launch = createTerminal.mock.calls[0]![1]!
      expect(launch.launchCause).toEqual(launchCause)
      expect(launch.command).toContain("'resume' 'session-1'")
      expect(launch.command).toContain('gpt-6.1-sol')
      expect(launch.command).toContain('high')
      expect(launch.command).not.toContain('model_reasoning_effort=low')
      expect(launch.command).toContain('features.web_search=true')
      const disabled = trigger === 'hibernation-wake'
      expect(launch.command).toContain(`check_for_update_on_startup=${!disabled}`)
      expect(launch.command).not.toContain(`check_for_update_on_startup=${disabled}`)
      expect(launch.env).toEqual({ CODEX_HOME: '/verified/worker/account' })
      expect(launch.launchConfig?.agentEnv).toEqual(launch.env)
      expect(settings).toEqual(before)
    }
  )
})
