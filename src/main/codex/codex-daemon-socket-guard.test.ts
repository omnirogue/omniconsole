import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})
// Why: the shared vitest setup keeps this guard inert for every other suite.
vi.unmock('./codex-daemon-socket-guard')

import {
  codexDaemonSocketPathExceedsLimit,
  disableCodexDaemonAutoStartForSocketPath,
  ensureCodexDaemonAutoStartFitsSocketPath
} from './codex-daemon-socket-guard'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

const SOCKET_SUFFIX = '/app-server-control/app-server-control.sock'
const LONG_MAC_HOME =
  '/Users/maintainer/Library/Application Support/omniconsole-ide/codex-accounts/1d5b700c-16db-472a-834e-4a1b9dd07d42/home'

// A POSIX home whose socket path is exactly `socketBytes` long.
function homeForSocketLength(socketBytes: number): string {
  return `/${'h'.repeat(socketBytes - SOCKET_SUFFIX.length - 1)}`
}

describe('codexDaemonSocketPathExceedsLimit', () => {
  it('needs room for the NUL terminator in sun_path', () => {
    expect(codexDaemonSocketPathExceedsLimit(homeForSocketLength(103), 'darwin')).toBe(false)
    expect(codexDaemonSocketPathExceedsLimit(homeForSocketLength(104), 'darwin')).toBe(true)
    expect(codexDaemonSocketPathExceedsLimit(homeForSocketLength(107), 'linux')).toBe(false)
    expect(codexDaemonSocketPathExceedsLimit(homeForSocketLength(108), 'linux')).toBe(true)
  })

  it('flags OmniConsole per-account homes but not a short ~/.codex', () => {
    expect(codexDaemonSocketPathExceedsLimit(LONG_MAC_HOME, 'darwin')).toBe(true)
    expect(codexDaemonSocketPathExceedsLimit('/Users/maintainer/.codex', 'darwin')).toBe(false)
    expect(
      codexDaemonSocketPathExceedsLimit(
        'C:\\Users\\sal\\AppData\\Roaming\\omniconsole-ide\\codex-accounts\\1d5b700c-16db-472a-834e-4a1b9dd07d42\\home',
        'win32'
      )
    ).toBe(true)
  })

  it('measures a WSL UNC home at its Linux guest path', () => {
    const runtimeHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\sal\\.local\\share\\omni\\codex-runtime-home\\home'
    const accountHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\sal\\.local\\share\\omni\\codex-accounts\\1d5b700c-16db-472a-834e-4a1b9dd07d42\\home'
    expect(codexDaemonSocketPathExceedsLimit(runtimeHome, 'win32')).toBe(false)
    expect(codexDaemonSocketPathExceedsLimit(accountHome, 'win32')).toBe(true)
  })

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    const home = `/${'é'.repeat(31)}${'h'.repeat(20)}`
    expect(home.length + SOCKET_SUFFIX.length).toBeLessThan(104)
    expect(codexDaemonSocketPathExceedsLimit(home, 'darwin')).toBe(true)
  })
})

describe('disableCodexDaemonAutoStartForSocketPath', () => {
  const disable = (config: string, home = LONG_MAC_HOME): string =>
    disableCodexDaemonAutoStartForSocketPath(config, home, 'darwin')

  it('leaves configs alone when the socket path fits', () => {
    const config = '[features]\ndaemon_auto_start = true\n'
    expect(disable(config, '/Users/maintainer/.codex')).toBe(config)
  })

  it('appends a features table when none exists', () => {
    expect(disable('')).toBe('[features]\ndaemon_auto_start = false\n')
    expect(disable('model = "gpt-5"\n')).toBe(
      'model = "gpt-5"\n\n[features]\ndaemon_auto_start = false\n'
    )
  })

  it('adds the key to an existing features table', () => {
    expect(disable('[features]\nhooks = true\n\n[tui]\ntheme = "dark"\n')).toBe(
      '[features]\nhooks = true\ndaemon_auto_start = false\n\n[tui]\ntheme = "dark"\n'
    )
  })

  it('overrides an explicit true, which would reproduce the bind failure', () => {
    expect(disable('[features]\ndaemon_auto_start = true\nhooks = true\n')).toBe(
      '[features]\ndaemon_auto_start = false\nhooks = true\n'
    )
  })

  it('is a no-op once the key is already false', () => {
    const config = 'model = "gpt-5"\n\n[features]\ndaemon_auto_start = false\n'
    expect(disable(config)).toBe(config)
  })

  it('keeps dotted features keys dotted so the table is not defined twice', () => {
    expect(disable('features.hooks = true\n\n[tui]\ntheme = "dark"\n')).toBe(
      'features.hooks = true\nfeatures.daemon_auto_start = false\n\n[tui]\ntheme = "dark"\n'
    )
  })

  it('never adds a second definition beside an inline features table', () => {
    const config = 'features = { hooks = true }\n'
    expect(disable(config)).toBe(config)
  })

  it('preserves CRLF line endings', () => {
    expect(disable('[features]\r\nhooks = true\r\n')).toBe(
      '[features]\r\nhooks = true\r\ndaemon_auto_start = false\r\n'
    )
  })
})

describe('managed home config sync', () => {
  let root: string
  let longHome: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omni-codex-daemon-guard-'))
    // Why: force the over-limit case regardless of the host temp-dir length.
    longHome = join(root, 'x'.repeat(120), 'home')
    mkdirSync(longHome, { recursive: true })
    mkdirSync(join(root, '.codex'), { recursive: true })
    homedirMock.mockReturnValue(root)
    getPathMock.mockReturnValue(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  const sync = (): void =>
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: longHome,
      systemHomePath: join(root, '.codex')
    })
  const runtimeConfig = (): string => readFileSync(join(longHome, 'config.toml'), 'utf-8')

  it('disables the daemon in the mirrored config without touching ~/.codex', () => {
    const systemConfig = 'model = "gpt-5"\n\n[features]\ndaemon_auto_start = true\n'
    writeFileSync(join(root, '.codex', 'config.toml'), systemConfig)

    sync()
    expect(runtimeConfig()).toBe('model = "gpt-5"\n\n[features]\ndaemon_auto_start = false\n')

    // Re-mirroring an existing runtime config keeps the guard in place.
    writeFileSync(join(root, '.codex', 'config.toml'), 'model = "gpt-5.5"\n')
    sync()
    expect(runtimeConfig()).toBe('model = "gpt-5.5"\n\n[features]\ndaemon_auto_start = false\n')
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf-8')).toBe('model = "gpt-5.5"\n')
  })

  it('still guards the home when ~/.codex/config.toml is missing', () => {
    sync()
    expect(runtimeConfig()).toBe('[features]\ndaemon_auto_start = false\n')
  })

  it('ensure leaves a home whose socket path fits untouched', () => {
    ensureCodexDaemonAutoStartFitsSocketPath('/tmp/h', 'linux')
    expect(existsSync('/tmp/h/config.toml')).toBe(false)
  })
})
