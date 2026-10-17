import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

// Why: deployAndLaunchRelay now reads `${localRelayDir}/.version` upfront
// (per docs/ssh-relay-versioned-install-dirs.md). The fs mock must report
// the local relay package as existing AND return a content-hashed version
// string so readLocalFullVersion succeeds.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.omni-remote',
  parseUnameToRelayPlatform: vi.fn((os: string, arch: string) => {
    const normalizedOs = os.toLowerCase()
    const normalizedArch = arch.toLowerCase()
    const relayArch = normalizedArch === 'arm64' || normalizedArch === 'aarch64' ? 'arm64' : 'x64'
    if (normalizedOs === 'windows' || normalizedOs === 'win32') {
      return `win32-${relayArch}`
    }
    if (normalizedOs === 'darwin') {
      return `darwin-${relayArch}`
    }
    if (normalizedOs === 'linux') {
      return `linux-${relayArch}`
    }
    return null
  }),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-endpoint-credential', () => ({
  writeRelayEndpointCredential: vi.fn().mockResolvedValue(undefined)
}))

// Why: the versioned-install modules shell out for install state, locking,
// and GC. Stub them so deploy tests need no real SSH connection.
vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.omni-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), {
      name: 'AbortError'
    })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import {
  isRelayAlreadyInstalled,
  gcOldRelayVersions,
  readLocalFullVersion
} from './ssh-relay-versioned-install'
import { writeRelayEndpointCredential } from './ssh-relay-endpoint-credential'
import { acquireInstallLock } from './ssh-relay-install-lock'
import type { SshConnection } from './ssh-connection'

function decodePowerShellCommand(command: string): string | null {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : null
}

const extractWindowsSockPath = (script: string): string =>
  /--sock-path\s+'([^']+)'/.exec(script)?.[1] ?? ''

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
      createWriteStream: vi.fn().mockReturnValue({
        on: vi.fn((_event: string, cb: () => void) => {
          if (_event === 'close') {
            setTimeout(cb, 0)
          }
        }),
        end: vi.fn()
      }),
      end: vi.fn()
    })
  } as unknown as SshConnection
}

describe('retained SSH relay connections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    vi.mocked(waitForSentinel).mockReset().mockResolvedValue({
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    })
    vi.mocked(resolveRemoteNodePath).mockReset().mockResolvedValue('/usr/bin/node')
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
    vi.mocked(acquireInstallLock).mockReset().mockResolvedValue(undefined)
  })

  it('reconnects to the saved build without deploying the newer local package', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Darwin arm64')
      .mockResolvedValueOnce('/Users/remote')
    const result = await deployAndLaunchRelay(conn, undefined, 0, 'target-a', '0.1.0+111111111111')
    expect(result.serverBuildId).toBe('0.1.0+111111111111')
    expect(result.remoteRelayDir).toBe('/Users/remote/.omni-remote/relay-0.1.0+111111111111')
    expect(conn.exec).toHaveBeenCalledTimes(1)
    expect(vi.mocked(conn.exec).mock.calls[0][0]).toContain('relay-0.1.0+111111111111')
    expect(vi.mocked(conn.exec).mock.calls[0][0]).toContain('--connect')
    expect(readLocalFullVersion).toHaveBeenCalledTimes(1)
    expect(writeRelayEndpointCredential).not.toHaveBeenCalled()
    expect(acquireInstallLock).not.toHaveBeenCalled()
    expect(gcOldRelayVersions).not.toHaveBeenCalled()
  })

  it('restarts a dead same-build relay through normal recovery', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('READY')
    const result = await deployAndLaunchRelay(conn, undefined, 0, 'target-a', '0.1.0+abcdef012345')
    expect(result.serverBuildId).toBe('0.1.0+abcdef012345')
    expect(
      vi.mocked(conn.exec).mock.calls.some(([command]) => command.includes('--detached'))
    ).toBe(true)
    // Binding retirement belongs to the owning-relay proof check, not deployment.
    expect(writeRelayEndpointCredential).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed retained connection unknown without launching or unlinking', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('retained relay unavailable'))
    await expect(
      deployAndLaunchRelay(conn, undefined, 0, 'target-a', '0.1.0+111111111111')
    ).rejects.toThrow('Reconnect to retry')
    expect(conn.exec).toHaveBeenCalledTimes(1)
    expect(vi.mocked(conn.exec).mock.calls[0][0]).not.toContain('--detached')
    expect(vi.mocked(execCommand).mock.calls.some(([, command]) => command.includes('rm -f'))).toBe(
      false
    )
    expect(writeRelayEndpointCredential).not.toHaveBeenCalled()
    expect(acquireInstallLock).not.toHaveBeenCalled()
  })

  it('does not reinstall a missing saved relay underneath surviving terminals', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValueOnce(false)
    await expect(
      deployAndLaunchRelay(conn, undefined, 0, 'target-a', '0.1.0+111111111111')
    ).rejects.toThrow('existing sessions remain unverifiable')
    expect(conn.exec).not.toHaveBeenCalled()
    expect(conn.sftp).not.toHaveBeenCalled()
    expect(writeRelayEndpointCredential).not.toHaveBeenCalled()
    expect(acquireInstallLock).not.toHaveBeenCalled()
  })

  it('connects only to a saved Windows relay without replacing its endpoint', async () => {
    const conn = makeMockConnection()
    const mockExecCommand = vi.mocked(execCommand)
    const persistedPipe = '\\\\.\\pipe\\omni-relay-1234567890abcdef1234'
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    mockExecCommand
      .mockRejectedValueOnce(new Error('uname not found')) // tagged POSIX platform probe
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64') // tagged PowerShell platform probe
      .mockResolvedValueOnce('C:\\Users\\me user') // remote home
      .mockResolvedValueOnce(`${persistedPipe}\n`) // persisted active pipe marker

    const result = await deployAndLaunchRelay(
      conn,
      undefined,
      300,
      'target-a',
      '0.1.0+111111111111'
    )

    const execCommands = vi.mocked(conn.exec).mock.calls.map(([cmd]) => cmd as string)
    expect(execCommands).toHaveLength(1)
    const connectScript = decodePowerShellCommand(execCommands[0]) ?? ''
    expect(extractWindowsSockPath(connectScript)).toBe(persistedPipe)
    expect(result.sockPath).toBe(persistedPipe)
    expect(result.serverBuildId).toBe('0.1.0+111111111111')
    expect(writeRelayEndpointCredential).not.toHaveBeenCalled()
    expect(acquireInstallLock).not.toHaveBeenCalled()

    const decodedExecScripts = mockExecCommand.mock.calls
      .map(([, command]) => decodePowerShellCommand(command))
      .filter((script): script is string => script !== null)
    expect(decodedExecScripts.some((script) => script.includes('Invoke-CimMethod'))).toBe(false)
  })
})
