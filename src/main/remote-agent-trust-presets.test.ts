import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getActiveMultiplexer: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('./ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: mocks.getActiveMultiplexer
}))

vi.mock('./providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: mocks.getSshFilesystemProvider
}))

const { markRemoteAgentWorkspaceTrusted } = await import('./remote-agent-trust-presets')

function makeFsProvider(overrides: Record<string, unknown> = {}) {
  return {
    realpath: vi.fn(async (path: string) => `/real${path}`),
    readFile: vi.fn(async () => ({ content: '', isBinary: false })),
    createDir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    stat: vi.fn(async () => {
      throw new Error('missing')
    }),
    ...overrides
  }
}

describe('markRemoteAgentWorkspaceTrusted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: '/home/u/' }))
    })
  })

  it('writes Codex trust to the remote home and canonicalized workspace path', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(mocks.getActiveMultiplexer).toHaveBeenCalledWith('ssh-1')
    expect(fsProvider.realpath).toHaveBeenCalledWith('/repo/worktree')
    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.codex')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.codex/config.toml',
      expect.stringContaining('[projects."/real/repo/worktree"]')
    )
  })

  it('writes Claude trust into the default profile and keeps other keys', async () => {
    const files: Record<string, string> = {
      '/home/u/.claude.json': JSON.stringify({ theme: 'dark', projects: { '/other': { x: 1 } } })
    }
    const fsProvider = makeFsProvider({
      stat: vi.fn(async (path: string) => {
        if (!(path in files)) {
          throw new Error('missing')
        }
        return {}
      }),
      readFile: vi.fn(async (path: string) => ({ content: files[path] ?? '', isBinary: false }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'claude',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree',
      agentConfigDir: ''
    })

    expect(fsProvider.writeFile).toHaveBeenCalledTimes(1)
    const [path, text] = fsProvider.writeFile.mock.calls[0] as unknown as [string, string]
    expect(path).toBe('/home/u/.claude.json')
    expect(JSON.parse(text)).toEqual({
      theme: 'dark',
      projects: {
        '/other': { x: 1 },
        '/real/repo/worktree': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
      }
    })
  })

  it('writes Claude trust into a pinned profile and never replaces a corrupt file', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)
    await markRemoteAgentWorkspaceTrusted({
      preset: 'claude',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree',
      agentConfigDir: '/home/u/.claude-accounts/slot-1/'
    })
    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.claude-accounts/slot-1')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.claude-accounts/slot-1/.claude.json',
      expect.stringContaining('"hasTrustDialogAccepted": true')
    )

    const corrupt = makeFsProvider({
      stat: vi.fn(async () => ({})),
      readFile: vi.fn(async () => ({ content: '{not json', isBinary: false }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(corrupt)
    await markRemoteAgentWorkspaceTrusted({
      preset: 'claude',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })
    expect(corrupt.writeFile).not.toHaveBeenCalled()
  })

  it('writes Codex trust when the remote home is a Windows absolute path', async () => {
    const fsProvider = makeFsProvider({
      realpath: vi.fn(async () => 'C:/Users/alice/platform')
    })
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'C:\\Users\\alice\\' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-windows',
      workspacePath: 'C:\\Users\\alice\\platform'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('C:/Users/alice/.codex')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:/Users/alice/.codex/config.toml',
      expect.stringContaining('[projects."C:/Users/alice/platform"]')
    )
  })

  it('writes trust to the selected remote Codex profile, preserving its other settings', async () => {
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({ content: 'model = "chosen"\n', isBinary: false }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)
    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/new-worktree',
      agentConfigDir: '/home/u/.codex-second'
    })
    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.codex-second')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.codex-second/config.toml',
      expect.stringContaining('model = "chosen"')
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.codex-second/config.toml',
      expect.stringContaining('[projects."/real/repo/new-worktree"]')
    )
  })

  it('writes Cursor trust marker on the remote host', async () => {
    const fsProvider = makeFsProvider()
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'cursor',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.cursor/projects/real-repo-worktree')
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      '/home/u/.cursor/projects/real-repo-worktree/.workspace-trusted',
      expect.stringContaining('"workspacePath": "/real/repo/worktree"')
    )
  })

  it('sanitizes Windows path characters in remote Cursor trust marker paths', async () => {
    const fsProvider = makeFsProvider({
      realpath: vi.fn(async () => 'C:/Users/alice/platform')
    })
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'C:/Users/alice/' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'cursor',
      connectionId: 'ssh-windows',
      workspacePath: 'C:\\Users\\alice\\platform'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith(
      'C:/Users/alice/.cursor/projects/C-Users-alice-platform'
    )
    expect(fsProvider.writeFile).toHaveBeenCalledWith(
      'C:/Users/alice/.cursor/projects/C-Users-alice-platform/.workspace-trusted',
      expect.stringContaining('"workspacePath": "C:/Users/alice/platform"')
    )
  })

  it('appends Copilot trusted folder remotely without clobbering config keys', async () => {
    const writeFile = vi.fn(async (_filePath: string, _content: string) => undefined)
    const fsProvider = makeFsProvider({
      readFile: vi.fn(async () => ({
        content: JSON.stringify({ firstLaunchAt: '2026-01-01', trustedFolders: ['/old'] }),
        isBinary: false
      })),
      writeFile
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'copilot',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.createDir).toHaveBeenCalledWith('/home/u/.copilot')
    const written = writeFile.mock.calls[0]?.[1]
    expect(typeof written).toBe('string')
    expect(JSON.parse(written as string)).toEqual({
      firstLaunchAt: '2026-01-01',
      trustedFolders: ['/old', '/real/repo/worktree']
    })
  })

  it('does nothing when the SSH home cannot be resolved safely', async () => {
    const fsProvider = makeFsProvider()
    mocks.getActiveMultiplexer.mockReturnValue({
      request: vi.fn(async () => ({ resolvedPath: 'relative/home' }))
    })
    mocks.getSshFilesystemProvider.mockReturnValue(fsProvider)

    await markRemoteAgentWorkspaceTrusted({
      preset: 'codex',
      connectionId: 'ssh-1',
      workspacePath: '/repo/worktree'
    })

    expect(fsProvider.writeFile).not.toHaveBeenCalled()
  })
})
