import { describe, expect, it } from 'vitest'
import {
  resolveLocalOrchestrationCliLauncher,
  resolveTerminalOrchestrationCliCommand
} from './cli-command'

describe('resolveTerminalOrchestrationCliCommand', () => {
  it('uses omni-ide for a pane recorded as WSL', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: true,
        worktreeId: 'repo::C:\\repo'
      })
    ).toBe('omni-ide')
  })

  it('uses project runtime and WSL paths when restored pane metadata is unavailable', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::C:\\repo',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'project:wsl:Ubuntu'
          }
        }
      })
    ).toBe('omni-ide')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      })
    ).toBe('omni-ide')
  })

  it('preserves native and SSH bare-omni commands', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/home/alice/repo'
      })
    ).toBe('omni')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: 'ssh-1',
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      })
    ).toBe('omni')
  })

  // Why: a bare `omni` resolves through the worker's login shell, which on this Mac
  // reached a different program; local terminals name the launcher by absolute path.
  it('names the local launcher for native local terminals only', () => {
    const launcher = '/Users/alice/Library/Application Support/omni-dev/cli/bin/omni-dev'
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/home/alice/repo',
        localLauncher: launcher
      })
    ).toBe(launcher)
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::/home/alice/repo',
        localLauncher: launcher
      })
    ).toBe(launcher)
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: 'ssh-1',
        isWsl: null,
        worktreeId: 'repo::/home/alice/repo',
        localLauncher: launcher
      })
    ).toBe('omni')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: true,
        worktreeId: 'repo::C:\\repo',
        localLauncher: launcher
      })
    ).toBe('omni-ide')
  })
})

describe('resolveLocalOrchestrationCliLauncher', () => {
  it('names the dev launcher under user data when it exists', () => {
    const seen: string[] = []
    expect(
      resolveLocalOrchestrationCliLauncher({
        isPackaged: false,
        userDataPath: '/Users/alice/Library/Application Support/omni-dev',
        resourcesPath: undefined,
        platform: 'darwin',
        exists: (path) => {
          seen.push(path)
          return true
        }
      })
    ).toBe('/Users/alice/Library/Application Support/omni-dev/cli/bin/omni-dev')
    expect(seen).toEqual(['/Users/alice/Library/Application Support/omni-dev/cli/bin/omni-dev'])
  })

  it('names the bundled CLI of a packaged macOS app and nothing on other hosts', () => {
    expect(
      resolveLocalOrchestrationCliLauncher({
        isPackaged: true,
        userDataPath: '/Users/alice/Library/Application Support/OmniConsole',
        resourcesPath: '/Applications/OmniConsole.app/Contents/Resources',
        platform: 'darwin',
        exists: () => true
      })
    ).toBe('/Applications/OmniConsole.app/Contents/Resources/bin/omni')
    expect(
      resolveLocalOrchestrationCliLauncher({
        isPackaged: true,
        userDataPath: '/home/alice/.config/omni',
        resourcesPath: '/opt/OmniConsole/resources',
        platform: 'linux',
        exists: () => true
      })
    ).toBeNull()
  })

  it('falls back to the bare name when the launcher is missing on disk', () => {
    expect(
      resolveLocalOrchestrationCliLauncher({
        isPackaged: false,
        userDataPath: '/tmp/user-data',
        resourcesPath: undefined,
        platform: 'darwin',
        exists: () => false
      })
    ).toBeNull()
  })
})
