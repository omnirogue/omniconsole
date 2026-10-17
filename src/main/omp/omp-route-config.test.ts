import { resolveOmpRouteLaunchArgs } from './omp-route-launch'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { getOmpApprovalOverlayConfigPath } from '../../shared/omp-approval-overlay'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
vi.mock('../providers/ssh-git-dispatch', () => ({ requireSshGitProvider: vi.fn() }))
vi.mock('./omp-route-version', () => ({ assertOmpRouteVersion: vi.fn() }))
import { expect, it, vi } from 'vitest'
import { ompRouteConfig } from './omp-route-config'
import { parseOmpExecutionReceipt } from './omp-execution-receipt'

const model = 'openrouter/x-ai/grok-exact'
const openrouterCandidates = ['x-ai/grok-exact', 'google/gemini-exact']
it('refuses a local command override that could replace an exact saved route', async () => {
  await expect(
    resolveOmpRouteLaunchArgs({
      agent: 'omp',
      preferences: { model },
      commandOverride: '/custom/omp',
      isRemote: false
    })
  ).rejects.toThrow('host default launcher')
})
it('fixed mode disables ambient fallback while explicit routes stay in one native retry chain', () => {
  expect(JSON.parse(ompRouteConfig({ model })).retry).toEqual({
    modelFallback: false,
    usageAwareFallback: false,
    fallbackChains: {},
    fallbackRevertPolicy: 'never'
  })
  expect(JSON.parse(ompRouteConfig({ model, openrouterCandidates })).retry).toEqual({
    modelFallback: true,
    usageAwareFallback: false,
    fallbackChains: { [model]: ['openrouter/google/gemini-exact'] },
    fallbackRevertPolicy: 'never'
  })
  expect(() =>
    ompRouteConfig({ model, openrouterCandidates: openrouterCandidates.toReversed() })
  ).toThrow()
})
it('uses observed assistant model evidence, rejecting out-of-route and unsuccessful finals', () => {
  const source = (effective: string, stopReason: string) =>
    [
      { type: 'session', id: 'session', timestamp: '2026-09-16T12:00:00Z' },
      {
        timestamp: '2026-09-16T12:00:01Z',
        type: 'message',
        id: 'first',
        parentId: null,
        message: {
          role: 'assistant',
          provider: 'openrouter',
          model: openrouterCandidates[0],
          stopReason: 'error'
        }
      },
      {
        timestamp: '2026-09-16T12:00:01Z',
        type: 'message',
        id: 'second',
        parentId: 'first',
        message: { role: 'assistant', provider: 'openrouter', model: effective, stopReason }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
  const input = {
    model,
    openrouterCandidates,
    machine: 'local',
    sessionId: 'session',
    notBefore: Date.parse('2026-09-16T11:59:59Z')
  }
  expect(parseOmpExecutionReceipt(source(openrouterCandidates[1], 'stop'), input)).toMatchObject({
    effective_model: openrouterCandidates[1],
    model_attempts: [{ model: openrouterCandidates[0] }, { model: openrouterCandidates[1] }]
  })
  expect(() =>
    parseOmpExecutionReceipt(source(openrouterCandidates[1], 'stop'), {
      ...input,
      notBefore: Date.parse('2026-09-16T12:00:02Z')
    })
  ).toThrow('fresh worker invocation')
  expect(() => parseOmpExecutionReceipt(source('other/model', 'stop'), input)).toThrow()
  expect(() => parseOmpExecutionReceipt(source(openrouterCandidates[1], 'error'), input)).toThrow()
  expect(() =>
    parseOmpExecutionReceipt(source(openrouterCandidates[1], 'stop'), {
      ...input,
      openrouterCandidates: undefined
    })
  ).toThrow()
})

it('materializes ordered SSH routes on the owner without sending local paths or credentials', async () => {
  const prepareOmpRoute = vi.fn().mockResolvedValue("'--config' '/remote/home/route.json'")
  vi.mocked(requireSshGitProvider).mockReturnValue({ prepareOmpRoute } as never)
  const args = await resolveOmpRouteLaunchArgs({
    agent: 'omp',
    preferences: { model, openrouterCandidates },
    isRemote: true,
    connectionId: 'host-a',
    agentArgs: `--config ${quoteStartupArg(getOmpApprovalOverlayConfigPath(), 'posix')}`
  })
  expect(args).toContain('/remote/home/route.json')
  expect(requireSshGitProvider).toHaveBeenCalledWith('host-a')
  expect(prepareOmpRoute).toHaveBeenCalledExactlyOnceWith({
    model,
    openrouterCandidates,
    approval: true,
    agentArgs: ''
  })
})

it.each([
  { commandOverride: '/client/bin/omp' },
  { agentEnv: { OPENROUTER_API_KEY: 'client-secret' } },
  { agentArgs: '--api-key client-secret' },
  { agentArgs: '--config /client/config.json' },
  { agentArgs: '--session-dir /client/sessions' },
  { isWsl: true },
  { connectionId: null }
])('refuses unsupported SSH launch authority before RPC: %j', async (override) => {
  const prepareOmpRoute = vi.fn()
  vi.mocked(requireSshGitProvider).mockReturnValue({ prepareOmpRoute } as never)
  await expect(
    resolveOmpRouteLaunchArgs({
      agent: 'omp',
      preferences: { model, openrouterCandidates },
      isRemote: true,
      connectionId: 'host-a',
      ...override
    })
  ).rejects.toThrow()
  expect(prepareOmpRoute).not.toHaveBeenCalled()
})

it('refuses a provider replacement while remote route preparation is in flight', async () => {
  const provider = { prepareOmpRoute: vi.fn().mockResolvedValue('--config /remote/a') }
  vi.mocked(requireSshGitProvider)
    .mockReturnValueOnce(provider as never)
    .mockReturnValueOnce({} as never)
  await expect(
    resolveOmpRouteLaunchArgs({
      agent: 'omp',
      preferences: { model },
      isRemote: true,
      connectionId: 'host-a'
    })
  ).rejects.toThrow('connection changed')
})
