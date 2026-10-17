import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import * as hostAccount from './agent-session-host-account'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type { SessionPrepRouterCatalog } from '../session-prep/session-prep-router-cli'

afterEach(() => vi.restoreAllMocks())

it.each([true, false])(
  'routes only the verified account model listing (advertised: %s), then replays',
  async (advertised) => {
    const runtime = new OrcaRuntimeService({
      getSettings: () => ({
        automaticOutcomeDispatch: true,
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {},
        nativeChatSessionOptions: { codex: { model: 'host-default' } }
      })
    } as never)
    const internal = runtime as unknown as {
      runtimeId: string
      resolveTerminalWorkspaceLaunchScope: ReturnType<typeof vi.fn>
      markLocalWorkspaceTrustedForAgent: ReturnType<typeof vi.fn>
      agentSessionModelCatalog: ReturnType<typeof vi.fn>
    }
    internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
      id: 'folder',
      path: '/owner/project',
      connectionId: null,
      repo: null,
      folderWorkspace: { id: 'folder', folderPath: '/owner/project' }
    }))
    internal.markLocalWorkspaceTrustedForAgent = vi.fn()
    internal.agentSessionModelCatalog = vi.fn(async (): Promise<SessionPrepRouterCatalog> => ({
      hostId: 'local',
      observedAt: Date.now(),
      agents: [
        {
          provider: 'codex',
          discovered: true,
          models: [
            {
              id: advertised ? 'gpt-6.1-sol' : 'gpt-6-astra',
              label: 'Sol',
              thinkingLevels: [{ id: 'medium', label: 'Medium' }]
            }
          ]
        }
      ]
    }))
    const route = vi.spyOn(runtime, 'routeSessionOutcomeModel').mockResolvedValue({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      mode: 'live',
      tier: 'standard',
      gate: 'allow',
      reason: 'Bounded repair',
      note: '',
      modelEvidence: 'advertised'
    })
    const prepare = vi.spyOn(hostAccount, 'prepareAgentSessionHostAccount').mockResolvedValue({
      env: { CODEX_HOME: '/owner/account' },
      fableVerified: true,
      assertCurrent: vi.fn()
    })
    const create = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_operation',
      tabId: '11111111-1111-4111-8111-111111111111',
      paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      ptyId: 'pty-operation',
      worktreeId: 'folder',
      title: null,
      surface: 'background'
    })
    const request: RuntimeCreateAgentSessionRequest = {
      clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
      worktree: 'id:folder',
      agent: 'codex',
      prompt: 'Fix one typo',
      viewMode: 'terminal',
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: 'local',
        expectedRuntimeId: internal.runtimeId
      }
    }
    const original = structuredClone(request)
    const first = await runtime.createAgentSession(request)
    expect(prepare.mock.calls[0][0].request.launchPreferences).toBeUndefined()
    expect(internal.agentSessionModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
      { CODEX_HOME: '/owner/account' },
      undefined,
      undefined
    )
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(route.mock.invocationCallOrder[0]!)
    const expectedModel = advertised ? 'gpt-6.1-sol' : 'host-default'
    expect(first.launch?.model).toBe(expectedModel)
    if (advertised) {
      expect(first.launch?.effort).toBe('medium')
    }
    expect(first.routing?.status).toBe(advertised ? 'selected' : 'unavailable')
    expect(create.mock.calls[0][1]?.command).toContain(expectedModel)
    const replay = await runtime.createAgentSession(request)
    expect(replay).toEqual({ ...first, disposition: 'replayed' })
    expect(request).toEqual(original)
    expect(route).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  }
)
