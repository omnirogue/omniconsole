import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCreateAgentSessionRequest } from '../../shared/agent-session-host-authority'
import type {
  SessionPrepRouterCatalog,
  SessionPrepRouterRequest,
  SessionPrepRouterResult
} from '../session-prep/session-prep-router-cli'
import { routeVerifiedAgentSessionModel } from './agent-session-model-routing'

function fixture(overrides: Partial<RuntimeCreateAgentSessionRequest> = {}) {
  const request: RuntimeCreateAgentSessionRequest = {
    clientOperationId: 'operation',
    worktree: 'id:folder',
    agent: 'codex',
    prompt: 'Fix this small typo',
    sshAccountSelection: {
      policy: 'best-verified',
      expectedHostId: 'local',
      expectedRuntimeId: 'runtime'
    },
    ...overrides
  }
  const catalog = vi.fn(
    async (_request?: SessionPrepRouterRequest): Promise<SessionPrepRouterCatalog> => ({
      hostId: 'local',
      observedAt: 1,
      agents: [
        {
          provider: 'codex',
          discovered: true,
          models: [
            { id: 'gpt-6.1-sol', label: 'Sol', thinkingLevels: [{ id: 'medium', label: 'Medium' }] }
          ]
        }
      ]
    })
  )
  const route = vi.fn(
    async (_request?: SessionPrepRouterRequest): Promise<SessionPrepRouterResult> => ({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      tier: 'standard',
      gate: 'allow',
      reason: 'Bounded repair',
      note: '',
      mode: 'live',
      modelEvidence: 'advertised'
    })
  )
  return {
    request,
    caller: {},
    enabled: true,
    runsInWsl: false,
    executionTarget: { path: '/owner/project', hostId: 'local', repoId: 'folder', isFolder: true },
    catalog,
    route
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('verified new-session model routing', () => {
  it('fills omitted choices from the exact execution catalog without mutating the caller', async () => {
    const input = fixture({ launchPreferences: { permissionMode: 'read-only' } })
    const original = structuredClone(input.request)
    const result = await routeVerifiedAgentSessionModel(input)
    expect(result.preferences).toEqual({
      permissionMode: 'read-only',
      model: 'gpt-6.1-sol',
      effort: 'medium'
    })
    expect(result.routing).toMatchObject({
      status: 'selected',
      modelEvidence: 'advertised',
      selected: { model: 'gpt-6.1-sol' }
    })
    expect(input.request).toEqual(original)
    expect(input.route).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: 'codex',
        enabledProviders: ['codex'],
        executionTarget: input.executionTarget,
        catalog: expect.objectContaining({ hostId: 'local' })
      })
    )
  })

  it.each([
    { launchPreferences: { model: 'pinned-model' } },
    { launchPreferences: { codexAccountId: 'account' } },
    { launchPreferences: { openrouterCandidates: [] } },
    { agentArgs: '--model pinned-model' },
    { agentArgs: null },
    { agentTemplateId: 'template' }
  ])('keeps explicit launch choices: %j', async (override) => {
    const input = fixture(override)
    const result = await routeVerifiedAgentSessionModel(input)
    expect(result.preferences).toBe(input.request.launchPreferences)
    expect(result.routing?.status).toBe('pinned')
    expect(input.catalog).not.toHaveBeenCalled()
    expect(input.route).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '   '])('retains defaults for an empty objective: %j', async (prompt) => {
    const input = fixture({ prompt })
    const result = await routeVerifiedAgentSessionModel(input)
    expect(result.preferences).toBe(input.request.launchPreferences)
    expect(result.routing).toBeUndefined()
    expect(input.catalog).not.toHaveBeenCalled()
    expect(input.route).not.toHaveBeenCalled()
  })

  it('keeps host-prepared accounts', async () => {
    const input = fixture()
    await routeVerifiedAgentSessionModel({
      ...input,
      caller: { preparedLaunchEnv: { CODEX_HOME: '/owner/account' } }
    })
    expect(input.route).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'unverified', 'off', 'wsl', 'wrong-host'])(
    'does not discover models for %s',
    async (kind) => {
      const input = fixture()
      if (kind === 'disabled') {
        input.enabled = false
      }
      if (kind === 'unverified') {
        delete input.request.sshAccountSelection
      }
      if (kind === 'off') {
        vi.stubEnv('OMNI_DISPATCH_ROUTER_MODE', 'off')
      }
      if (kind === 'wsl') {
        input.runsInWsl = true
      }
      if (kind === 'wrong-host') {
        input.executionTarget.hostId = 'ssh:other'
      }
      const result = await routeVerifiedAgentSessionModel(input)
      expect(result.preferences).toBeUndefined()
      expect(input.catalog).not.toHaveBeenCalled()
      expect(input.route).not.toHaveBeenCalled()
      if (kind === 'off') {
        expect(result.routing?.status).toBe('off')
      }
    }
  )

  it('shadow records its candidate without changing launch choices', async () => {
    vi.stubEnv('OMNI_DISPATCH_ROUTER_MODE', 'shadow')
    const input = fixture()
    const result = await routeVerifiedAgentSessionModel(input)
    expect(result.preferences).toBeUndefined()
    expect(result.routing?.status).toBe('shadow')
    expect(input.route.mock.calls[0][0]?.mode).toBe('shadow')
  })

  it('preserves an effort-only choice', async () => {
    const input = fixture({ launchPreferences: { effort: 'medium' } })
    const result = await routeVerifiedAgentSessionModel(input)
    expect(result.preferences).toEqual({ model: 'gpt-6.1-sol', effort: 'medium' })
    expect(input.route.mock.calls[0][0]?.effort).toBe('medium')
  })

  it.each(['effort', 'provider', 'seed', 'missing-model', 'wrong-catalog'])(
    'refuses an incompatible %s decision',
    async (kind) => {
      const input = fixture({ launchPreferences: { effort: 'medium' } })
      if (kind === 'effort') {
        input.route.mockResolvedValueOnce({
          ...(await input.route()),
          effort: 'high'
        } as SessionPrepRouterResult)
      }
      if (kind === 'provider') {
        input.route.mockResolvedValueOnce({
          ...(await input.route()),
          provider: 'claude'
        } as SessionPrepRouterResult)
      }
      if (kind === 'seed' || kind === 'missing-model' || kind === 'wrong-catalog') {
        const catalog = await input.catalog()
        if (kind === 'seed') {
          catalog.agents[0].discovered = false
        }
        if (kind === 'missing-model') {
          catalog.agents[0].models = []
        }
        if (kind === 'wrong-catalog') {
          catalog.hostId = 'ssh:other'
        }
        input.catalog.mockResolvedValueOnce(catalog)
      }
      const result = await routeVerifiedAgentSessionModel(input)
      expect(result.preferences).toBe(input.request.launchPreferences)
      expect(result.routing?.status).toBe('unavailable')
    }
  )

  it('falls back visibly when discovery or the classifier fails', async () => {
    const input = fixture()
    input.catalog.mockRejectedValueOnce(new Error('offline'))
    expect(await routeVerifiedAgentSessionModel(input)).toMatchObject({
      preferences: undefined,
      routing: { status: 'unavailable' }
    })
    input.route.mockResolvedValueOnce({
      status: 'unavailable',
      unrouted: 'Classifier unavailable',
      mode: 'live'
    })
    expect(await routeVerifiedAgentSessionModel(input)).toMatchObject({
      preferences: undefined,
      routing: { status: 'unavailable', reason: 'Classifier unavailable' }
    })
  })

  it('holds a live impossible quality gate but does not hold in shadow', async () => {
    const input = fixture()
    input.route.mockResolvedValue({
      status: 'unavailable',
      unrouted: 'Required quality unavailable',
      blocking: true,
      mode: 'live'
    })
    await expect(routeVerifiedAgentSessionModel(input)).rejects.toThrow(
      'Required quality unavailable'
    )
    vi.stubEnv('OMNI_DISPATCH_ROUTER_MODE', 'shadow')
    await expect(routeVerifiedAgentSessionModel(input)).resolves.toMatchObject({
      preferences: undefined,
      routing: { status: 'unavailable' }
    })
  })
})
