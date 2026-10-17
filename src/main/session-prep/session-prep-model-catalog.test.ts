import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiscoverCommitMessageModelsResult } from '../text-generation/commit-message-text-generation'
import {
  createSessionPrepModelCatalog,
  type SessionPrepModelDiscovery
} from './session-prep-model-catalog'
import type { SessionPrepRouterRequest } from './session-prep-router-types'

const remote = vi.hoisted(() => ({
  executeCommitMessagePlan: vi.fn(),
  discoverOmpRoutes: vi.fn(),
  list: vi.fn(),
  omp: vi.fn()
}))
vi.mock('../providers/ssh-git-dispatch', () => ({ requireSshGitProvider: () => remote }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  discoverCommitMessageModelsRemote: (...args: unknown[]) => remote.list(...args)
}))
vi.mock('../text-generation/model-discovery-cache', () => ({
  discoverRemoteOmpRoutes: (...args: unknown[]) => remote.omp(...args)
}))

const request: SessionPrepRouterRequest = {
  brief: 'Format supplied data into a table',
  title: 'Format data',
  enabledProviders: ['codex'],
  executionTarget: { path: '/selected/repo', repoId: 'repo-1', hostId: 'local' }
}
function listing(origin: 'probe' | 'spec' = 'probe'): DiscoverCommitMessageModelsResult {
  return {
    success: true,
    catalogOrigin: origin,
    defaultModelId: 'gpt-6-luna',
    capability: {
      id: 'codex',
      label: 'Codex',
      modelSource: 'dynamic',
      models: [],
      defaultModelId: 'gpt-6-luna'
    },
    models: [{ id: 'gpt-6-luna', label: 'Luna' }]
  }
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
describe('execution-owner routing model catalog', () => {
  it('shares in-flight discovery, then reuses the account-aware owner rather than keeping a stale catalog', async () => {
    let finish!: (value: DiscoverCommitMessageModelsResult) => void
    const probe = vi
      .fn<SessionPrepModelDiscovery>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(listing())
    const catalog = createSessionPrepModelCatalog(probe)
    const first = catalog(request),
      second = catalog(request)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    finish(listing())
    expect((await first).agents[0]?.discovered).toBe(true)
    await second
    await catalog(request)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledWith('id:repo-1::/selected/repo', 'codex')
  })
  it('keeps static menus and failed listings unavailable', async () => {
    const probe = vi
      .fn<SessionPrepModelDiscovery>()
      .mockResolvedValueOnce(listing('spec'))
      .mockRejectedValueOnce(new Error('Probe unavailable'))
    const catalog = createSessionPrepModelCatalog(probe)
    expect((await catalog(request)).agents[0]?.discovered).toBe(false)
    expect((await catalog(request)).agents[0]).toMatchObject({
      discovered: false,
      error: 'Probe unavailable'
    })
  })
  it('never substitutes the local host for an unresolved paired owner', async () => {
    const probe = vi.fn<SessionPrepModelDiscovery>()
    const result = await createSessionPrepModelCatalog(probe)({
      ...request,
      executionTarget: { ...request.executionTarget!, hostId: 'runtime:elsewhere' }
    })
    expect(probe).not.toHaveBeenCalled()
    expect(result.agents[0]?.discovered).toBe(false)
  })
  it('bounds foreground waiting without starting a duplicate discovery', async () => {
    vi.useFakeTimers()
    let finish!: (value: DiscoverCommitMessageModelsResult) => void
    const probe = vi.fn<SessionPrepModelDiscovery>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const catalog = createSessionPrepModelCatalog(probe)
    const first = catalog(request)
    await vi.advanceTimersByTimeAsync(3000)
    expect((await first).agents[0]?.error).toContain('pending')
    const second = catalog(request)
    finish(listing())
    expect((await second).agents[0]?.discovered).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('uses SSH folder discovery and the attested OMP route listing on the chosen connection', async () => {
    remote.omp.mockResolvedValue(listing())
    const probe = vi.fn<SessionPrepModelDiscovery>()
    const result = await createSessionPrepModelCatalog(probe)({
      ...request,
      enabledProviders: ['omp'],
      executionTarget: {
        path: '/remote/folder',
        repoId: 'folder:remote',
        isFolder: true,
        hostId: 'ssh:chosen',
        connectionId: 'chosen'
      }
    })
    expect(remote.omp).toHaveBeenCalledWith('chosen', expect.any(Function))
    expect(probe).not.toHaveBeenCalled()
    expect(result.hostId).toBe('ssh:chosen')
  })
})
