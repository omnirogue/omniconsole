import { registerOmpRouteHandlers } from '../../relay/omp-route-handler'
import { runProcess } from '../../shared/child-process/run-process'
import { ompRouteLaunchArgs } from './omp-route-config'
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('./omp-route-config', () => ({ ompRouteLaunchArgs: vi.fn() }))
import { afterEach, expect, it, vi } from 'vitest'
import { attestOmpRouteModels } from './omp-route-model-discovery'
import { assertOmpRouteVersion } from './omp-route-version'
import {
  createModelDiscoveryCache,
  installLocalModelDiscoveryCache
} from '../text-generation/model-discovery-cache'
import {
  _resetQuietBackgroundAgentRunsReaderForTests,
  setQuietBackgroundAgentRunsReader
} from '../text-generation/quiet-background-runs'
import type { DiscoverCommitMessageModelsResult } from '../text-generation/source-control-text-generation-types'
vi.mock('./omp-route-version', () => ({ assertOmpRouteVersion: vi.fn() }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
it('attests only authenticated exact OpenRouter rows with tool support on a capable host', async () => {
  const result = {
    success: true,
    catalogOrigin: 'probe',
    models: [
      { id: 'openrouter/vendor/opaque:free', label: 'eligible' },
      { id: 'openrouter/vendor/no-tools', label: 'ineligible' },
      { id: 'other/vendor/opaque:free', label: 'other provider' }
    ]
  } as DiscoverCommitMessageModelsResult
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'vendor/opaque:free', supported_parameters: ['tools'] },
          { id: 'vendor/no-tools', supported_parameters: [] }
        ]
      })
    })
  )
  const attested = await attestOmpRouteModels(result, {})
  expect(attested.success && attested.models.map((model) => model.openrouterRouting)).toEqual([
    'omp-openrouter-routing-v1',
    undefined,
    undefined
  ])
  expect(
    await attestOmpRouteModels(
      { ...result, catalogOrigin: 'spec' } as DiscoverCommitMessageModelsResult,
      {}
    )
  ).toEqual({ ...result, catalogOrigin: 'spec' })
  vi.mocked(assertOmpRouteVersion).mockRejectedValue(new Error('old host'))
  expect(await attestOmpRouteModels(result, {})).toEqual(result)
})

it('checks OMP routing once per OMP binary for the listing lifetime on a host with a cache', async () => {
  let binary = 'omp:1'
  installLocalModelDiscoveryCache(createModelDiscoveryCache({ fingerprint: async () => binary }))
  const result = {
    success: true,
    catalogOrigin: 'probe',
    models: [{ id: 'openrouter/vendor/opaque:free', label: 'eligible' }]
  } as DiscoverCommitMessageModelsResult
  const catalog = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'vendor/opaque:free', supported_parameters: ['tools'] }] })
  }))
  vi.stubGlobal('fetch', catalog)
  const environment = { PATH: '/host/omp/bin' }
  try {
    const first = await attestOmpRouteModels(result, environment)
    expect(first.success && first.models[0]?.openrouterRouting).toBe('omp-openrouter-routing-v1')
    // Why: `omp --version` (a bun process) and the OpenRouter fetch ran on every listing before.
    await expect(attestOmpRouteModels(result, environment)).resolves.toEqual(first)
    expect(assertOmpRouteVersion).toHaveBeenCalledOnce()
    expect(catalog).toHaveBeenCalledOnce()

    // An OMP update checks again; a host too old for routing is not re-checked on every listing.
    binary = 'omp:2'
    vi.mocked(assertOmpRouteVersion).mockRejectedValue(new Error('old host'))
    await expect(attestOmpRouteModels(result, environment)).resolves.toEqual(result)
    await expect(attestOmpRouteModels(result, environment)).resolves.toEqual(result)
    expect(assertOmpRouteVersion).toHaveBeenCalledTimes(2)

    setQuietBackgroundAgentRunsReader(() => false)
    await attestOmpRouteModels(result, environment)
    expect(assertOmpRouteVersion).toHaveBeenCalledTimes(3)
  } finally {
    installLocalModelDiscoveryCache(null)
    _resetQuietBackgroundAgentRunsReaderForTests()
  }
})

it('re-checks OMP routing that failed on a launch’s explicit refresh', async () => {
  installLocalModelDiscoveryCache(createModelDiscoveryCache({ fingerprint: async () => 'omp:1' }))
  const result = {
    success: true,
    catalogOrigin: 'probe',
    models: [{ id: 'openrouter/vendor/opaque:free', label: 'eligible' }]
  } as DiscoverCommitMessageModelsResult
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'vendor/opaque:free', supported_parameters: ['tools'] }] })
    }))
  )
  const environment = { PATH: '/host/omp/bin' }
  try {
    vi.mocked(assertOmpRouteVersion).mockRejectedValueOnce(new Error('omp --version timed out'))
    await expect(attestOmpRouteModels(result, environment)).resolves.toEqual(result)
    await expect(attestOmpRouteModels(result, environment)).resolves.toEqual(result)
    expect(assertOmpRouteVersion).toHaveBeenCalledOnce()
    const forced = await attestOmpRouteModels(result, environment, { force: true })
    expect(forced.success && forced.models[0]?.openrouterRouting).toBe('omp-openrouter-routing-v1')
    expect(assertOmpRouteVersion).toHaveBeenCalledTimes(2)
  } finally {
    installLocalModelDiscoveryCache(null)
  }
})

it('cancels an unavailable model catalog response without claiming route support', async () => {
  const result = {
    success: true,
    catalogOrigin: 'probe',
    models: [{ id: 'openrouter/vendor/model', label: 'host model' }]
  } as DiscoverCommitMessageModelsResult
  const response = new Response('Unavailable', { status: 503 })
  const cancel = vi.spyOn(response.body!, 'cancel')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
  expect(await attestOmpRouteModels(result, {})).toEqual(result)
  expect(cancel).toHaveBeenCalledOnce()
})

it.skipIf(process.platform === 'win32')(
  'relay re-probes host auth and every fallback before writing a route',
  async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    registerOmpRouteHandlers({
      onRequest: (name: string, handler: never) => handlers.set(name, handler)
    } as never)
    const selected = ['vendor/opaque:free', 'other/exact']
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
      stdout: JSON.stringify({ models: selected.map((id) => ({ provider: 'openrouter', id })) })
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: selected.map((id) => ({ id, supported_parameters: ['tools'] }))
        })
      })
    )
    vi.mocked(ompRouteLaunchArgs).mockReturnValue('--config /host/route.json')
    const request = {
      model: `openrouter/${selected[0]}`,
      openrouterCandidates: selected,
      agentArgs: '--yolo',
      approval: false
    }
    await expect(handlers.get('agent.ompRoutePrepareV1')!(request)).resolves.toEqual({
      capability: 'omp-openrouter-routing-v1',
      agentArgs: '--config /host/route.json'
    })
    expect(ompRouteLaunchArgs).toHaveBeenCalledWith(
      expect.objectContaining({ preferences: request, agentArgs: '--yolo', shell: 'posix' })
    )
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'omp',
        args: ['models', 'ls', '--json'],
        env: expect.any(Object)
      })
    )
    vi.mocked(ompRouteLaunchArgs).mockClear()
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
      stdout: JSON.stringify({ models: [{ provider: 'openrouter', id: selected[0] }] })
    })
    await expect(handlers.get('agent.ompRoutePrepareV1')!(request)).rejects.toThrow(
      'Every selected model'
    )
    expect(ompRouteLaunchArgs).not.toHaveBeenCalled()
    await expect(
      handlers.get('agent.ompRoutePrepareV1')!({
        ...request,
        env: { OPENROUTER_API_KEY: 'client-secret' }
      })
    ).rejects.toThrow()
    await expect(
      handlers.get('agent.ompRoutePrepareV1')!({ ...request, agentArgs: '--config /client/path' })
    ).rejects.toThrow('explicit OMP config')
  }
)
