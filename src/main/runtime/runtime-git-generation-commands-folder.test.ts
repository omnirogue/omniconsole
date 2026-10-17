import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  discoverLocal: vi.fn(),
  discoverRemote: vi.fn(),
  prepareEnv: vi.fn(),
  attestOmp: vi.fn(),
  getSshGitProvider: vi.fn()
}))

vi.mock('../omp/omp-route-model-discovery', () => ({ attestOmpRouteModels: mocks.attestOmp }))

vi.mock('../text-generation/commit-message-text-generation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discoverCommitMessageModelsLocal: mocks.discoverLocal,
  discoverCommitMessageModelsRemote: mocks.discoverRemote
}))
vi.mock('../providers/ssh-git-dispatch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSshGitProvider: mocks.getSshGitProvider
}))
vi.mock('../text-generation/commit-message-agent-environment', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareLocalCommitMessageAgentEnv: mocks.prepareEnv
}))

import { RuntimeGitGenerationCommands } from './runtime-git-generation-commands'
import type { RuntimeGitCommandHost } from './runtime-git-command-target'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import {
  createModelDiscoveryCache,
  installLocalModelDiscoveryCache
} from '../text-generation/model-discovery-cache'

function commands(
  resolveRuntimeGitTarget = vi.fn(),
  resolvers?: CommitMessageAgentEnvironmentResolvers
) {
  const host = {
    resolveRuntimeGitTarget,
    getRuntimeSettings: () => ({ agentCmdOverrides: { codex: '/opt/codex' } }),
    getCommitMessageAgentEnvironment: () => resolvers
  } as unknown as RuntimeGitCommandHost
  return { resolveRuntimeGitTarget, generation: new RuntimeGitGenerationCommands(host) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('model discovery for a folder workspace', () => {
  it('probes this host instead of resolving a git target that does not exist', async () => {
    mocks.prepareEnv.mockResolvedValue({ ok: true, env: { PATH: '/bin' } })
    mocks.discoverLocal.mockResolvedValue({ success: true, catalogOrigin: 'probe', models: [] })
    const { resolveRuntimeGitTarget, generation } = commands()
    await expect(
      generation.discoverRuntimeCommitMessageModels('id:folder:company-docs', 'codex')
    ).resolves.toMatchObject({ success: true, catalogOrigin: 'probe' })
    expect(resolveRuntimeGitTarget).not.toHaveBeenCalled()
    expect(mocks.prepareEnv).toHaveBeenCalledWith('codex', undefined, { runtime: 'host' })
    expect(mocks.discoverLocal).toHaveBeenCalledWith('codex', { PATH: '/bin' }, '/opt/codex')
  })

  it('reports an unavailable host environment and still resolves git worktrees normally', async () => {
    mocks.prepareEnv.mockResolvedValue({ ok: false, error: 'codex is not signed in' })
    const { resolveRuntimeGitTarget, generation } = commands(
      vi.fn().mockRejectedValue(new Error('selector_not_found'))
    )
    await expect(
      generation.discoverRuntimeCommitMessageModels('folder:company-docs', 'codex')
    ).resolves.toEqual({ success: false, error: 'codex is not signed in' })
    await expect(
      generation.discoverRuntimeCommitMessageModels('id:repo::/work', 'codex')
    ).rejects.toThrow('selector_not_found')
    expect(resolveRuntimeGitTarget).toHaveBeenCalledWith('id:repo::/work')
  })

  it('attests folder OpenRouter routes on their host and excludes custom OMP commands', async () => {
    const env = { PATH: '/host/bin' }
    const catalog = {
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'openrouter/moonshotai/kimi-k2.5', label: 'Kimi K2.5' }]
    }
    const attested = {
      ...catalog,
      models: [{ ...catalog.models[0], openrouterRouting: 'omp-openrouter-routing-v1' }]
    }
    mocks.prepareEnv.mockResolvedValue({ ok: true, env })
    mocks.discoverLocal.mockResolvedValue(catalog)
    mocks.attestOmp.mockResolvedValue(attested)
    const { generation, resolveRuntimeGitTarget } = commands()
    await expect(
      generation.discoverRuntimeCommitMessageModels('folder:company-docs', 'omp')
    ).resolves.toEqual(attested)
    expect(mocks.attestOmp).toHaveBeenCalledExactlyOnceWith(catalog, env)
    expect(resolveRuntimeGitTarget).not.toHaveBeenCalled()

    await expect(
      generation.discoverRuntimeCommitMessageModels('folder:company-docs', 'omp', {
        agentCmdOverrides: { omp: '/custom/omp' }
      })
    ).resolves.toEqual(catalog)
    expect(mocks.discoverLocal).toHaveBeenLastCalledWith('omp', env, '/custom/omp')
    expect(mocks.attestOmp).toHaveBeenCalledOnce()
  })
})

describe('model discovery for an SSH worktree', () => {
  it('lists on the host’s own model-discovery lane, keyed to its connection', async () => {
    const executeCommitMessagePlan = vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false
    }))
    mocks.getSshGitProvider.mockReturnValue({ executeCommitMessagePlan })
    mocks.discoverRemote.mockResolvedValue({ success: true, catalogOrigin: 'probe', models: [] })
    const { generation } = commands(
      vi.fn().mockResolvedValue({ worktree: { path: '/remote/repo' }, connectionId: 'conn-1' })
    )
    await generation.discoverRuntimeCommitMessageModels('id:repo::/remote/repo', 'cursor')
    expect(mocks.discoverRemote).toHaveBeenCalledWith(
      'cursor',
      '/remote/repo',
      expect.any(Function),
      undefined,
      'conn-1'
    )
    const execute = mocks.discoverRemote.mock.calls[0]?.[2] as (
      plan: unknown,
      cwd: string,
      timeoutMs: number
    ) => Promise<unknown>
    await execute({ binary: 'cursor-agent', args: ['--list-models'] }, '/remote/repo', 60_000)
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      { binary: 'cursor-agent', args: ['--list-models'] },
      '/remote/repo',
      60_000,
      'model-discovery'
    )
  })
})

describe('a launch’s explicit model refresh', () => {
  it('reaches the listing for a folder, a local worktree and an SSH worktree', async () => {
    mocks.prepareEnv.mockResolvedValue({ ok: true, env: { PATH: '/bin' } })
    mocks.discoverLocal.mockResolvedValue({ success: true, catalogOrigin: 'probe', models: [] })
    mocks.discoverRemote.mockResolvedValue({ success: true, catalogOrigin: 'probe', models: [] })
    mocks.getSshGitProvider.mockReturnValue({ executeCommitMessagePlan: vi.fn() })
    const resolve = vi.fn().mockResolvedValue({ worktree: { path: '/work' } })
    const { generation } = commands(resolve)
    const force = { force: true }

    await generation.discoverRuntimeCommitMessageModels('folder:company-docs', 'codex', {}, force)
    expect(mocks.discoverLocal).toHaveBeenLastCalledWith('codex', { PATH: '/bin' }, '/opt/codex', {
      force: true
    })
    await generation.discoverRuntimeCommitMessageModels('id:repo::/work', 'codex', {}, force)
    expect(mocks.discoverLocal).toHaveBeenLastCalledWith('codex', { PATH: '/bin' }, '/opt/codex', {
      force: true
    })
    resolve.mockResolvedValue({ worktree: { path: '/remote/repo' }, connectionId: 'conn-1' })
    await generation.discoverRuntimeCommitMessageModels(
      'id:repo::/remote/repo',
      'cursor',
      {},
      force
    )
    expect(mocks.discoverRemote).toHaveBeenLastCalledWith(
      'cursor',
      '/remote/repo',
      expect.any(Function),
      undefined,
      'conn-1',
      { force: true }
    )
  })
})

describe('a launcher opening answered from this host’s listing', () => {
  it('sets up the Codex account once across folder and local worktree openings', async () => {
    installLocalModelDiscoveryCache(
      createModelDiscoveryCache({ fingerprint: async () => '/opt/codex:1:1' })
    )
    try {
      const env = { PATH: '/bin', CODEX_HOME: '/codex/homes/a' }
      mocks.prepareEnv.mockResolvedValue({ ok: true, env })
      mocks.discoverLocal.mockResolvedValue({ success: true, catalogOrigin: 'probe', models: [] })
      const resolvers = { prepareForCodexLaunch: vi.fn(), listingAccount: () => 'a' }
      const { generation } = commands(
        vi.fn().mockResolvedValue({ worktree: { path: '/work' } }),
        resolvers
      )

      await generation.discoverRuntimeCommitMessageModels('folder:company-docs', 'codex')
      await generation.discoverRuntimeCommitMessageModels('folder:company-docs', 'codex')
      await generation.discoverRuntimeCommitMessageModels('id:repo::/work', 'codex')
      await generation.discoverRuntimeCommitMessageModels('id:repo::/work', 'codex')
      // Same CLI, same selected account, same host: one account setup and one listing.
      expect(mocks.prepareEnv).toHaveBeenCalledExactlyOnceWith('codex', resolvers, {
        runtime: 'host'
      })
      expect(mocks.discoverLocal).toHaveBeenCalledExactlyOnceWith('codex', env, '/opt/codex')
    } finally {
      installLocalModelDiscoveryCache(null)
    }
  })
})
