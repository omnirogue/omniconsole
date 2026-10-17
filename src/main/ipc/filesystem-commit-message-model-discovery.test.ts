import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  withPlatform,
  WORKSPACE_DIR,
  WORKTREE_FEATURE_PATH,
  discoverCommitMessageModelsLocalMock,
  discoverCommitMessageModelsRemoteMock,
  getSshGitProviderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

const ompMocks = vi.hoisted(() => ({
  attest: vi.fn(),
  environment: { PATH: '/host/omp/bin' }
}))

vi.mock('../omp/omp-route-model-discovery', () => ({ attestOmpRouteModels: ompMocks.attest }))
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => ompMocks.environment
}))

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import {
  createModelDiscoveryCache,
  installLocalModelDiscoveryCache
} from '../text-generation/model-discovery-cache'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    ompMocks.attest.mockReset()
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
  })

  const ompCatalog = {
    success: true,
    catalogOrigin: 'probe',
    models: [{ id: 'openrouter/google/gemini-2.5-flash-lite', label: 'Gemini Flash Lite' }]
  }
  const attestedOmpCatalog = {
    ...ompCatalog,
    models: [{ ...ompCatalog.models[0], openrouterRouting: 'omp-openrouter-routing-v1' }]
  }

  it.each(['host', 'worktree', 'folder'])(
    'attests desktop OMP discovery for a %s',
    async (scope) => {
      const folderPath = path.resolve('/outside-workspace/omp-project')
      const scopedStore = {
        ...store,
        getFolderWorkspaces: () => [
          { id: 'folder-omp', projectGroupId: 'group-1', folderPath, connectionId: null }
        ]
      }
      discoverCommitMessageModelsLocalMock.mockResolvedValue(ompCatalog)
      ompMocks.attest.mockResolvedValue(attestedOmpCatalog)
      registerFilesystemHandlers(scopedStore as never)
      const worktreePath =
        scope === 'host' ? undefined : scope === 'folder' ? folderPath : WORKTREE_FEATURE_PATH

      await expect(
        handlers.get('git:discoverCommitMessageModels')!(null, { agentId: 'omp', worktreePath })
      ).resolves.toEqual(attestedOmpCatalog)
      expect(ompMocks.attest).toHaveBeenCalledExactlyOnceWith(
        ompCatalog,
        expect.objectContaining(ompMocks.environment)
      )
      expect(discoverCommitMessageModelsRemoteMock).not.toHaveBeenCalled()
    }
  )

  it('does not attest a custom local OMP command', async () => {
    discoverCommitMessageModelsLocalMock.mockResolvedValue(ompCatalog)
    registerFilesystemHandlers({
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { omp: '/custom/omp' }
      })
    } as never)

    await expect(
      handlers.get('git:discoverCommitMessageModels')!(null, { agentId: 'omp' })
    ).resolves.toEqual(ompCatalog)
    expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
      'omp',
      expect.objectContaining(ompMocks.environment),
      '/custom/omp'
    )
    expect(ompMocks.attest).not.toHaveBeenCalled()
  })

  it('does not attest WSL OMP using the desktop host', async () => {
    await withPlatform('win32', async () => {
      const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\tester\\omp-project'
      discoverCommitMessageModelsLocalMock.mockResolvedValue(ompCatalog)
      registerFilesystemHandlers({
        ...store,
        getFolderWorkspaces: () => [
          { id: 'folder-omp', projectGroupId: 'group-1', folderPath, connectionId: null }
        ]
      } as never)

      await expect(
        handlers.get('git:discoverCommitMessageModels')!(null, {
          agentId: 'omp',
          worktreePath: folderPath
        })
      ).resolves.toEqual(ompCatalog)
      expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
        'omp',
        undefined,
        undefined,
        { cwd: path.resolve(folderPath), wslDistro: 'Ubuntu' }
      )
      expect(ompMocks.attest).not.toHaveBeenCalled()
    })
  })

  it('uses the SSH execution host to attest OMP and never substitutes a local probe', async () => {
    const discoverOmpRoutes = vi.fn().mockResolvedValue(attestedOmpCatalog)
    getSshGitProviderMock.mockReturnValue({ discoverOmpRoutes })
    registerFilesystemHandlers(store as never)
    const args = { agentId: 'omp', worktreePath: '/remote/repo', connectionId: 'conn-1' }

    await expect(handlers.get('git:discoverCommitMessageModels')!(null, args)).resolves.toEqual(
      attestedOmpCatalog
    )
    expect(getSshGitProviderMock).toHaveBeenCalledWith('conn-1')
    expect(discoverOmpRoutes).toHaveBeenCalledOnce()

    discoverOmpRoutes.mockRejectedValue(new Error('SSH connection lost'))
    await expect(handlers.get('git:discoverCommitMessageModels')!(null, args)).resolves.toEqual({
      success: false,
      error: 'SSH connection lost'
    })
    getSshGitProviderMock.mockReturnValue(undefined)
    await expect(
      handlers.get('git:discoverCommitMessageModels')!(null, args)
    ).resolves.toMatchObject({ success: false })
    expect(discoverCommitMessageModelsLocalMock).not.toHaveBeenCalled()
    expect(discoverCommitMessageModelsRemoteMock).not.toHaveBeenCalled()
    expect(ompMocks.attest).not.toHaveBeenCalled()
  })

  it('reuses the SSH host OMP route listing while the app cache holds it', async () => {
    installLocalModelDiscoveryCache(createModelDiscoveryCache())
    try {
      const discoverOmpRoutes = vi.fn().mockResolvedValue(attestedOmpCatalog)
      getSshGitProviderMock.mockReturnValue({ discoverOmpRoutes })
      registerFilesystemHandlers(store as never)
      const args = { agentId: 'omp', worktreePath: '/remote/repo', connectionId: 'conn-1' }
      const discover = handlers.get('git:discoverCommitMessageModels')!
      await expect(discover(null, args)).resolves.toEqual(attestedOmpCatalog)
      await expect(discover(null, args)).resolves.toEqual(attestedOmpCatalog)
      expect(discoverOmpRoutes).toHaveBeenCalledOnce()
    } finally {
      installLocalModelDiscoveryCache(null)
    }
  })

  it('re-checks a failed SSH host OMP route listing on a launch’s explicit refresh', async () => {
    installLocalModelDiscoveryCache(createModelDiscoveryCache())
    try {
      const discoverOmpRoutes = vi
        .fn()
        .mockResolvedValueOnce({ success: false, error: 'relay busy' })
        .mockResolvedValue(attestedOmpCatalog)
      getSshGitProviderMock.mockReturnValue({ discoverOmpRoutes })
      registerFilesystemHandlers(store as never)
      const args = { agentId: 'omp', worktreePath: '/remote/repo', connectionId: 'conn-1' }
      const discover = handlers.get('git:discoverCommitMessageModels')!
      await expect(discover(null, args)).resolves.toMatchObject({ success: false })
      await expect(discover(null, args)).resolves.toMatchObject({ success: false })
      expect(discoverOmpRoutes).toHaveBeenCalledOnce()
      await expect(discover(null, { ...args, force: true })).resolves.toEqual(attestedOmpCatalog)
      expect(discoverOmpRoutes).toHaveBeenCalledTimes(2)
    } finally {
      installLocalModelDiscoveryCache(null)
    }
  })

  it('sets up the Claude account once for two launcher openings answered from the host', async () => {
    installLocalModelDiscoveryCache(
      createModelDiscoveryCache({ fingerprint: async () => '/usr/local/bin/claude:1:1' })
    )
    try {
      const claudeCatalog = { ...ompCatalog, models: [{ id: 'opus', label: 'Opus' }] }
      const prepareForClaudeLaunch = vi.fn().mockResolvedValue({
        configDir: '/seats/1',
        envPatch: { CLAUDE_CONFIG_DIR: '/seats/1' },
        stripAuthEnv: true,
        provenance: 'managed:seat-1'
      })
      const resolvers = { prepareForClaudeLaunch, listingAccount: () => 'seat-1' }
      discoverCommitMessageModelsLocalMock.mockResolvedValue(claudeCatalog)
      registerFilesystemHandlers(store as never, resolvers)
      const discover = handlers.get('git:discoverCommitMessageModels')!

      await expect(discover(null, { agentId: 'claude' })).resolves.toEqual(claudeCatalog)
      await expect(discover(null, { agentId: 'claude' })).resolves.toEqual(claudeCatalog)
      expect(prepareForClaudeLaunch).toHaveBeenCalledOnce()
      expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledExactlyOnceWith(
        'claude',
        expect.objectContaining({ CLAUDE_CONFIG_DIR: '/seats/1' }),
        undefined
      )
    } finally {
      installLocalModelDiscoveryCache(null)
    }
  })

  it('passes a launch’s explicit refresh through to the listing on each host', async () => {
    discoverCommitMessageModelsLocalMock.mockResolvedValue(ompCatalog)
    ompMocks.attest.mockResolvedValue(attestedOmpCatalog)
    getSshGitProviderMock.mockReturnValue({ executeCommitMessagePlan: vi.fn() })
    registerFilesystemHandlers(store as never)
    const discover = handlers.get('git:discoverCommitMessageModels')!

    await discover(null, { agentId: 'codex', force: true })
    expect(discoverCommitMessageModelsLocalMock).toHaveBeenLastCalledWith(
      'codex',
      undefined,
      undefined,
      { force: true }
    )
    await discover(null, { agentId: 'omp', force: true })
    expect(ompMocks.attest).toHaveBeenLastCalledWith(
      ompCatalog,
      expect.objectContaining(ompMocks.environment),
      { force: true }
    )
    await discover(null, {
      agentId: 'cursor',
      worktreePath: '/remote/repo',
      connectionId: 'conn-1',
      force: true
    })
    expect(discoverCommitMessageModelsRemoteMock).toHaveBeenLastCalledWith(
      'cursor',
      '/remote/repo',
      expect.any(Function),
      undefined,
      'conn-1',
      { force: true }
    )
  })

  it('preserves custom OMP commands on the SSH host without attesting them', async () => {
    const discoverOmpRoutes = vi.fn()
    getSshGitProviderMock.mockReturnValue({ discoverOmpRoutes, executeCommitMessagePlan: vi.fn() })
    discoverCommitMessageModelsRemoteMock.mockResolvedValue(ompCatalog)
    registerFilesystemHandlers({
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { omp: '/custom/omp' }
      })
    } as never)

    await expect(
      handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'omp',
        worktreePath: '/remote/repo',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual(ompCatalog)
    expect(discoverCommitMessageModelsRemoteMock).toHaveBeenCalledWith(
      'omp',
      '/remote/repo',
      expect.any(Function),
      '/custom/omp',
      'conn-1'
    )
    expect(discoverOmpRoutes).not.toHaveBeenCalled()
    expect(ompMocks.attest).not.toHaveBeenCalled()
  })

  it('passes per-agent command overrides into local model discovery', async () => {
    discoverCommitMessageModelsLocalMock.mockResolvedValue({
      success: true,
      capability: {
        id: 'codex',
        label: 'Codex',
        modelSource: 'dynamic',
        defaultModelId: 'gpt-5.5',
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
      },
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
      defaultModelId: 'gpt-5.5'
    })
    const storeWithOverride = {
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { codex: 'npx codex' }
      })
    }

    registerFilesystemHandlers(storeWithOverride as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, { agentId: 'codex' })

    expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
      'codex',
      undefined,
      'npx codex'
    )
  })

  it('discovers models from an exact repo-less folder workspace root', async () => {
    const folderPath = path.resolve('/outside-workspace/folder-project')
    const folderStore = {
      ...store,
      getFolderWorkspaces: () => [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath,
          connectionId: null
        }
      ]
    }
    discoverCommitMessageModelsLocalMock.mockResolvedValue({
      success: true,
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      defaultModelId: 'sonnet'
    })

    registerFilesystemHandlers(folderStore as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, {
      agentId: 'claude',
      worktreePath: folderPath
    })

    expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
      'claude',
      undefined,
      undefined,
      { cwd: folderPath }
    )
  })

  it('does not authorize remote-only folder roots as local discovery paths', async () => {
    const folderPath = path.resolve('/remote-only/folder-project')
    const folderStore = {
      ...store,
      getFolderWorkspaces: () => [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath,
          connectionId: 'ssh-1'
        }
      ]
    }

    registerFilesystemHandlers(folderStore as never)

    await expect(
      handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'claude',
        worktreePath: folderPath
      })
    ).rejects.toThrow('Access denied')
    expect(discoverCommitMessageModelsLocalMock).not.toHaveBeenCalled()
  })

  it('routes a repo-less WSL folder workspace discovery through its distro', async () => {
    await withPlatform('win32', async () => {
      const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\tester\\folder-project'
      const prepareForClaudeLaunch = vi.fn().mockResolvedValue({
        configDir: '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.claude',
        envPatch: { CLAUDE_CONFIG_DIR: '/home/tester/.claude' },
        stripAuthEnv: true,
        provenance: 'managed:account-1'
      })
      const folderStore = {
        ...store,
        getFolderWorkspaces: () => [
          {
            id: 'folder-1',
            projectGroupId: 'group-1',
            folderPath,
            connectionId: null
          }
        ]
      }
      discoverCommitMessageModelsLocalMock.mockResolvedValue({
        success: true,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        defaultModelId: 'sonnet'
      })

      registerFilesystemHandlers(folderStore as never, { prepareForClaudeLaunch })

      await handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'claude',
        worktreePath: folderPath
      })

      expect(prepareForClaudeLaunch).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({ CLAUDE_CONFIG_DIR: '/home/tester/.claude' }),
        undefined,
        { cwd: path.resolve(folderPath), wslDistro: 'Ubuntu' }
      )
    })
  })

  it('routes local WSL project model discovery through the project runtime target', async () => {
    await withPlatform('win32', async () => {
      discoverCommitMessageModelsLocalMock.mockResolvedValue({
        success: true,
        capability: {
          id: 'codex',
          label: 'Codex',
          modelSource: 'dynamic',
          defaultModelId: 'gpt-5.5',
          models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
        },
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
        defaultModelId: 'gpt-5.5'
      })
      const prepareForCodexLaunch = vi.fn(() => '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex')
      const wslStore = {
        ...store,
        getRepos: () => [
          {
            id: 'repo-1',
            path: WORKTREE_FEATURE_PATH,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 0
          }
        ],
        getProjects: () => [
          {
            id: 'project-1',
            sourceRepoIds: ['repo-1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }
        ],
        getSettings: () => ({
          workspaceDir: WORKSPACE_DIR,
          agentCmdOverrides: { codex: 'npx codex' },
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      }

      registerFilesystemHandlers(wslStore as never, { prepareForCodexLaunch })

      await handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'codex',
        worktreePath: WORKTREE_FEATURE_PATH
      })

      expect(prepareForCodexLaunch).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' }),
        'npx codex',
        { cwd: WORKTREE_FEATURE_PATH, wslDistro: 'Ubuntu' }
      )
    })
  })

  it('routes SSH model discovery through the remote git provider', async () => {
    discoverCommitMessageModelsRemoteMock.mockResolvedValue({
      success: true,
      capability: {
        id: 'cursor',
        label: 'Cursor',
        modelSource: 'dynamic',
        defaultModelId: 'auto',
        models: [{ id: 'auto', label: 'Auto' }]
      },
      models: [{ id: 'auto', label: 'Auto' }],
      defaultModelId: 'auto'
    })
    const executeCommitMessagePlan = vi.fn()
    getSshGitProviderMock.mockReturnValue({ executeCommitMessagePlan })
    const storeWithOverride = {
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { cursor: 'npx cursor-agent' }
      })
    }

    registerFilesystemHandlers(storeWithOverride as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, {
      agentId: 'cursor',
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })

    // Keyed to the connection so the host's listing is reused across its worktrees.
    expect(discoverCommitMessageModelsRemoteMock).toHaveBeenCalledWith(
      'cursor',
      '/remote/repo',
      expect.any(Function),
      'npx cursor-agent',
      'conn-1'
    )
    const execute = discoverCommitMessageModelsRemoteMock.mock.calls[0]?.[2] as (
      plan: unknown,
      cwd: string,
      timeoutMs: number
    ) => Promise<unknown>
    await execute({ binary: 'cursor-agent', args: ['--list-models'] }, '/remote/repo', 60_000)
    // Its own relay lane: a commit message on that worktree never queues behind a listing.
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      { binary: 'cursor-agent', args: ['--list-models'] },
      '/remote/repo',
      60_000,
      'model-discovery'
    )
    expect(discoverCommitMessageModelsLocalMock).not.toHaveBeenCalled()
  })
})
