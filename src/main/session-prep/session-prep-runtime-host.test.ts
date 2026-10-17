import { prepareSessionPrepRemoteAccount } from './session-prep-remote-account'
import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { createSessionPrepRuntimeHost, type SessionPrepRuntime } from './session-prep-runtime-host'
import { sessionPrepDefaultSource } from './session-prep-default-source'

vi.mock('./session-prep-remote-account', () => ({
  prepareSessionPrepRemoteAccount: vi.fn()
}))

function folder(executionHostId?: FolderWorkspace['executionHostId']): FolderWorkspace {
  return {
    id: 'folder-one',
    projectGroupId: 'project-one',
    name: 'Work',
    folderPath: '/same/path',
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function runtime(workspace: FolderWorkspace) {
  return {
    listRepos: () => [],
    listFolderWorkspaces: () => [workspace],
    listManagedWorktrees: vi.fn(),
    createManagedWorktree: vi.fn(),
    createAgentSession: vi.fn(async () => ({ terminal: { tabId: 'new-session' } })),
    requestSessionFolders: vi.fn()
  } satisfies SessionPrepRuntime
}

describe('session prep folder execution owner', () => {
  it('resolves inherited organization folders by exact ID without creating a replacement', async () => {
    const owner = runtime(folder())
    owner.requestSessionFolders.mockResolvedValue({
      folders: [{ id: 'other', name: 'missing-id', path: 'missing-id' }]
    })
    const host = createSessionPrepRuntimeHost(owner, () => [])
    await expect(host.resolveExistingFolder!('missing-id')).rejects.toThrow('no longer exists')
    await expect(host.resolveExistingFolder!('other')).resolves.toEqual({
      id: 'other',
      path: 'missing-id'
    })
    expect(owner.requestSessionFolders.mock.calls).toEqual([[{ kind: 'list' }], [{ kind: 'list' }]])
  })

  it('refuses paired folders instead of launching in a same-path local folder', async () => {
    const owner = runtime(folder('runtime:other-mac'))
    const host = createSessionPrepRuntimeHost(owner, () => [])
    await expect(host.resolveWorktree('folder-one')).resolves.toMatchObject({
      hostId: 'runtime:other-mac',
      isRemote: true
    })
    await expect(
      host.createAgentSessionIn({
        worktreeId: 'folder-one',
        agent: 'claude',
        prompt: 'Do the work',
        clientOperationId: 'operation-one'
      })
    ).rejects.toThrow('Choose the SSH workspace')
    expect(owner.createAgentSession).not.toHaveBeenCalled()
  })

  it('still launches a local folder without a legacy host stamp', async () => {
    const owner = runtime(folder())
    const host = createSessionPrepRuntimeHost(owner, () => [])
    await expect(
      host.createAgentSessionIn({
        worktreeId: 'folder-one',
        agent: 'claude',
        prompt: 'Do the work',
        clientOperationId: 'operation-one'
      })
    ).resolves.toMatchObject({ tabId: 'new-session' })
  })
})

describe('session prep folder workspace ids', () => {
  it.each(['folder:folder-one', 'folder-one'])(
    'resolves %s and launches through the runtime folder key',
    async (worktreeId) => {
      const owner = runtime(folder())
      const host = createSessionPrepRuntimeHost(owner, () => [])
      await expect(host.resolveWorktree(worktreeId)).resolves.toMatchObject({
        path: '/same/path',
        isFolder: true
      })
      await host.createAgentSessionIn({
        worktreeId,
        agent: 'claude',
        prompt: 'Do the work',
        clientOperationId: 'operation-one'
      })
      expect(owner.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ worktree: 'id:folder:folder-one' }),
        expect.anything()
      )
    }
  )

  it('still refuses an unknown folder', async () => {
    const host = createSessionPrepRuntimeHost(runtime(folder()), () => [])
    await expect(host.resolveWorktree('folder:missing')).rejects.toThrow('not available')
  })
})

describe('session prep default source', () => {
  it('is the local Work root folder, never an SSH or archived one', () => {
    const work = { ...folder(), id: 'work', folderPath: '/home/me/Work' }
    expect(sessionPrepDefaultSource([work], {}, '/home/me')).toBe('folder:work')
    expect(
      sessionPrepDefaultSource([work], { companyWorkRoot: '~/Companies' }, '/home/me')
    ).toBeNull()
    expect(sessionPrepDefaultSource([{ ...work, connectionId: 'dev' }], {}, '/home/me')).toBeNull()
    expect(sessionPrepDefaultSource([{ ...work, isArchived: true }], {}, '/home/me')).toBeNull()
  })
})

describe('new workspace batch provenance', () => {
  it.each(['git', 'folder'] as const)(
    'carries the batch cause for a %s workspace startup',
    async (kind) => {
      const owner = runtime(folder())
      const repo = { id: 'repo-one', path: '/same/path', displayName: 'Work', kind }
      const live = { ...owner, listRepos: () => [repo as never] }
      owner.createManagedWorktree.mockResolvedValue({
        worktree: { id: 'new-workspace' },
        startupTerminal: { spawned: true, tabId: 'new-tab' }
      })
      const host = createSessionPrepRuntimeHost(live, () => [])
      await host.createWorktreeWithAgent({
        repoId: repo.id,
        name: 'prepared',
        agent: 'claude',
        prompt: 'private prompt',
        batchId: 'sp_1234567'
      })
      expect(owner.createManagedWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          startupLaunchCause: {
            trigger: 'session-prep',
            reference: { sessionPrepBatchId: 'sp_1234567' },
            actor: { kind: 'app' }
          }
        })
      )
    }
  )

  it('returns the exact startup terminal handle and resolves its runtime pane identity', async () => {
    const owner = runtime(folder())
    owner.createManagedWorktree.mockResolvedValue({
      worktree: { id: 'new-workspace' },
      startupTerminal: { spawned: true, handle: 'terminal-handle', tabId: 'new-tab' }
    })
    const live = {
      ...owner,
      listRepos: () => [
        { id: 'repo-one', path: '/same/path', displayName: 'Work', kind: 'git' as const } as never
      ],
      getTerminalPaneKey: vi.fn(() => 'runtime-pane-key')
    }
    const host = createSessionPrepRuntimeHost(live, () => [])
    const created = await host.createWorktreeWithAgent({
      repoId: 'repo-one',
      name: 'prepared',
      agent: 'claude',
      prompt: 'Do work'
    })
    expect(created.paneHandle).toBe('terminal-handle')
    await expect(host.resolveTerminalPaneKey?.('terminal-handle')).resolves.toBe('runtime-pane-key')
    expect(live.getTerminalPaneKey).toHaveBeenCalledWith('terminal-handle')
  })
})

describe('routed launch account boundary', () => {
  it.each(['session', 'worktree'] as const)(
    'passes frozen local account environment into %s launch',
    async (kind) => {
      const owner = runtime(folder())
      owner.createManagedWorktree.mockResolvedValue({
        worktree: { id: 'created' },
        startupTerminal: { spawned: true }
      })
      const prepare = vi.fn(async () => ({ CODEX_HOME: '/chosen/local' }))
      const live = {
        ...owner,
        prepareSessionPrepRoutedLaunch: prepare,
        listRepos: () => [
          { id: 'repo', path: '/same/path', displayName: 'Work', kind: 'git' } as never
        ]
      }
      const host = createSessionPrepRuntimeHost(live, () => [])
      const common = {
        agent: 'codex' as const,
        prompt: 'Work',
        launch: { model: 'gpt-6-luna' },
        routedModel: 'gpt-6-luna'
      }
      if (kind === 'session') {
        await host.createAgentSessionIn({
          ...common,
          worktreeId: 'folder-one',
          clientOperationId: 'operation-one'
        })
        expect(owner.createAgentSession).toHaveBeenCalledWith(
          expect.objectContaining({
            clientOperationId: 'operation-one',
            launchPreferences: common.launch
          }),
          expect.objectContaining({ preparedLaunchEnv: { CODEX_HOME: '/chosen/local' } })
        )
      } else {
        await host.createWorktreeWithAgent({ ...common, repoId: 'repo', name: 'prepared' })
        expect(owner.createManagedWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ startupLaunchEnv: { CODEX_HOME: '/chosen/local' } })
        )
      }
      expect(prepare).toHaveBeenCalledOnce()
    }
  )

  it.each(['session', 'worktree'] as const)(
    'refuses an unavailable routed model before %s side effects',
    async (kind) => {
      const owner = runtime(folder())
      const prepare = vi.fn(async () => {
        throw new Error('Account does not advertise model. Nothing launched.')
      })
      const live = {
        ...owner,
        prepareSessionPrepRoutedLaunch: prepare,
        listRepos: () => [
          { id: 'repo', path: '/same/path', displayName: 'Work', kind: 'git' } as never
        ]
      }
      const host = createSessionPrepRuntimeHost(live, () => [])
      const common = {
        agent: 'codex' as const,
        prompt: 'Work',
        launch: { model: 'gpt-6-luna' },
        routedModel: 'gpt-6-luna'
      }
      await expect(
        kind === 'session'
          ? host.createAgentSessionIn({
              ...common,
              worktreeId: 'folder-one',
              clientOperationId: 'operation-one'
            })
          : host.createWorktreeWithAgent({ ...common, repoId: 'repo', name: 'prepared' })
      ).rejects.toThrow('Nothing launched')
      expect(owner.createAgentSession).not.toHaveBeenCalled()
      expect(owner.createManagedWorktree).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, { model: 'gpt-6-luna' }])(
    'leaves explicit/default choices unchanged without routed provenance: %s',
    async (launch) => {
      const owner = runtime(folder())
      const prepare = vi.fn()
      const host = createSessionPrepRuntimeHost(
        { ...owner, prepareSessionPrepRoutedLaunch: prepare },
        () => []
      )
      await host.createAgentSessionIn({
        worktreeId: 'folder-one',
        clientOperationId: 'operation-one',
        agent: 'codex',
        prompt: 'Work',
        launch
      })
      expect(prepare).not.toHaveBeenCalled()
      expect(owner.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining(launch ? { launchPreferences: launch } : { agent: 'codex' }),
        expect.anything()
      )
    }
  )
})

it.each(['session', 'worktree'] as const)(
  'verifies and forwards the exact SSH-selected account for %s',
  async (kind) => {
    const owner = runtime(folder())
    owner.createManagedWorktree.mockResolvedValue({
      worktree: { id: 'created' },
      startupTerminal: { spawned: true }
    })
    const chosen = { CODEX_HOME: '/remote/account', OPENAI_API_KEY: '' }
    vi.mocked(prepareSessionPrepRemoteAccount).mockResolvedValue(chosen)
    const prepare = vi.fn(
      async (input: { accountEnv?: Record<string, string> }) => input.accountEnv!
    )
    const live = {
      ...owner,
      prepareSessionPrepRoutedLaunch: prepare,
      listRepos: () => [
        {
          id: 'repo',
          path: '/same/path',
          displayName: 'Work',
          kind: 'git',
          connectionId: 'remote',
          executionHostId: 'ssh:remote'
        } as never
      ]
    }
    const host = createSessionPrepRuntimeHost(
      live,
      () => [],
      () => [{ id: 'remote', generation: 1, host: 'remote' } as never]
    )
    const common = {
      agent: 'codex' as const,
      prompt: 'Work',
      launch: { model: 'gpt-6-luna' },
      routedModel: 'gpt-6-luna'
    }
    if (kind === 'session') {
      await host.createAgentSessionIn({
        ...common,
        worktreeId: 'repo::/same/path',
        clientOperationId: 'operation-one'
      })
      expect(owner.createAgentSession).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ preparedLaunchEnv: chosen })
      )
    } else {
      await host.createWorktreeWithAgent({ ...common, repoId: 'repo', name: 'prepared' })
      expect(owner.createManagedWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ startupLaunchEnv: chosen })
      )
    }
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        accountEnv: chosen,
        workspace: expect.objectContaining({ connectionId: 'remote' })
      })
    )
    expect(prepare.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(prepareSessionPrepRemoteAccount).mock.invocationCallOrder.at(-1)!
    )
  }
)
