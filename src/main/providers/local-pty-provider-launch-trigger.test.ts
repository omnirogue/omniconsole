import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsPtyJobProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsPtyJobProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/omni-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Resolve PowerShell family names to deterministic absolute paths (the fs mock
// above otherwise makes every probe miss). The real resolver — which skips the
// Store App Execution Alias stub — is covered in
// windows-powershell-executable.test.ts.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../wsl', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'
import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import {
  _resetLaunchStageTracesForTests,
  hashLaunchWorktreeId
} from '../observability/launch-stage-trace'

// Latency telemetry: the local-provider spawn path records the launch cause on
// launch.process_spawn, like the daemon path (daemon-spawn-launch-stage-trace.test.ts).
describe('LocalPtyProvider launch trigger', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined
  let records: Record<string, unknown>[]

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsPtyJobProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })
    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)
    records = []
    const sink: TracerSink = {
      push(record) {
        records.push(record as Record<string, unknown>)
      },
      flush() {
        /* no-op */
      },
      close() {
        /* no-op */
      }
    }
    setActiveSink(sink)
    _resetLaunchStageTracesForTests()
    provider = new LocalPtyProvider()
  })

  afterEach(() => {
    _resetLaunchStageTracesForTests()
    _resetTracerForTests()
  })

  function processSpawnAttributes(): Record<string, unknown> {
    const record = records.find((entry) => entry.name === 'launch.process_spawn')
    return (record?.attributes ?? {}) as Record<string, unknown>
  }

  it('records the trigger, visibility and hashed worktree of an agent launch', async () => {
    await provider.spawn({
      cols: 80,
      rows: 24,
      command: 'claude',
      launchAgent: 'claude',
      paneKey: 'tab-1:pane-1',
      worktreeId: 'repo::/Users/maintainer/Work/wt',
      launchTrigger: 'person-reveal',
      launchVisible: true
    })

    const attributes = processSpawnAttributes()
    expect(attributes['launch.trigger']).toBe('person-reveal')
    expect(attributes['launch.visible']).toBe(true)
    expect(attributes['launch.worktree']).toBe(hashLaunchWorktreeId('repo::/Users/maintainer/Work/wt'))
    expect(JSON.stringify(records)).not.toContain('/Users/maintainer/Work/wt')
  })

  it('defaults an agent launch with no named trigger to unknown', async () => {
    await provider.spawn({ cols: 80, rows: 24, command: 'codex' })

    expect(processSpawnAttributes()['launch.trigger']).toBe('unknown')
  })
})
