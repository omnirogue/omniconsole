import { describe, expect, it } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { agentLaunchRunsInWsl } from './agent-launch-wsl-runtime'

const wslProject: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'p',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'k'
  }
}
const hostProject: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'p',
    reason: 'global-default',
    cacheKey: 'k'
  }
}
const repairProject: ProjectExecutionRuntimeResolution = {
  status: 'repair-required',
  repair: {
    projectId: 'p',
    preferredRuntime: { kind: 'wsl', distro: null },
    reason: 'wsl-unavailable',
    source: 'global-default',
    cacheKey: 'k'
  }
}

function runsInWsl(change: Partial<Parameters<typeof agentLaunchRunsInWsl>[0]> = {}): boolean {
  return agentLaunchRunsInWsl({
    path: 'C:\\code\\app',
    connectionId: null,
    platform: 'win32',
    projectRuntime: undefined,
    terminalWindowsShell: 'powershell.exe',
    ...change
  })
}

describe('agent launch WSL runtime', () => {
  it('follows the project runtime for a Windows path, as spawn preflight does', () => {
    expect(runsInWsl({ projectRuntime: wslProject })).toBe(true)
    expect(runsInWsl({ projectRuntime: repairProject })).toBe(true)
    expect(runsInWsl({ projectRuntime: hostProject, terminalWindowsShell: 'wsl.exe' })).toBe(false)
  })

  it('falls back to the terminal shell setting when no project runtime applies', () => {
    expect(runsInWsl({ terminalWindowsShell: 'C:\\Windows\\System32\\wsl.exe' })).toBe(true)
    expect(runsInWsl()).toBe(false)
  })

  it('treats a WSL path as WSL anywhere, and SSH or non-Windows hosts as never WSL', () => {
    expect(runsInWsl({ path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app' })).toBe(true)
    expect(runsInWsl({ connectionId: 'worker', projectRuntime: wslProject })).toBe(false)
    expect(runsInWsl({ platform: 'darwin', path: '/work', terminalWindowsShell: 'wsl.exe' })).toBe(
      false
    )
  })
})
