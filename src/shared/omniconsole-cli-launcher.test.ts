import { afterEach, describe, expect, it } from 'vitest'
import {
  applyLocalOmniConsoleCliLauncher,
  getLocalOmniConsoleCliLauncher,
  normalizeOmniConsoleCliLauncherForMatch,
  setLocalOmniConsoleCliLauncher
} from './omniconsole-cli-launcher'
import { quoteStartupArg } from './tui-agent-startup-shell'

const LAUNCHER = '/Users/maintainer/Applications/OmniConsole.app/Contents/Resources/bin/omni'
const QUOTED = quoteStartupArg(LAUNCHER, 'posix')

afterEach(() => {
  setLocalOmniConsoleCliLauncher(null)
})

describe('applyLocalOmniConsoleCliLauncher', () => {
  it('names the bundled launcher by path for a local POSIX Agent Teams launch', () => {
    expect(
      applyLocalOmniConsoleCliLauncher("omni claude-teams '--dangerously-skip-permissions'", {
        platform: 'darwin',
        shell: 'posix',
        launcher: LAUNCHER
      })
    ).toBe(`${QUOTED} claude-teams '--dangerously-skip-permissions'`)
    expect(
      applyLocalOmniConsoleCliLauncher('omni-dev claude-teams', {
        platform: 'linux',
        shell: 'posix',
        launcher: '/home/sal/.config/omni-dev/cli/bin/omni-dev'
      })
    ).toBe(
      `${quoteStartupArg('/home/sal/.config/omni-dev/cli/bin/omni-dev', 'posix')} claude-teams`
    )
  })

  it('reads the registered launcher, including a lazy resolver, when none is passed', () => {
    setLocalOmniConsoleCliLauncher(() => `  ${LAUNCHER}  `)
    expect(getLocalOmniConsoleCliLauncher()).toBe(LAUNCHER)
    expect(
      applyLocalOmniConsoleCliLauncher('omni claude-teams', { platform: 'darwin', shell: 'posix' })
    ).toBe(`${QUOTED} claude-teams`)
  })

  it('keeps the bare name when no launcher is on disk or the resolver fails', () => {
    expect(
      applyLocalOmniConsoleCliLauncher('omni claude-teams', { platform: 'darwin', shell: 'posix' })
    ).toBe('omni claude-teams')
    setLocalOmniConsoleCliLauncher(() => {
      throw new Error('no app environment')
    })
    expect(getLocalOmniConsoleCliLauncher()).toBeNull()
    expect(
      applyLocalOmniConsoleCliLauncher('omni claude-teams', {
        platform: 'darwin',
        shell: 'posix',
        launcher: null
      })
    ).toBe('omni claude-teams')
  })

  it('never rewrites remote, Windows, non-POSIX, pathed or foreign commands', () => {
    const args = { platform: 'darwin' as const, shell: 'posix' as const, launcher: LAUNCHER }
    expect(applyLocalOmniConsoleCliLauncher('omni claude-teams', { ...args, isRemote: true })).toBe(
      'omni claude-teams'
    )
    expect(
      applyLocalOmniConsoleCliLauncher('omni.cmd claude-teams', { ...args, platform: 'win32' })
    ).toBe('omni.cmd claude-teams')
    expect(
      applyLocalOmniConsoleCliLauncher('omni claude-teams', { ...args, shell: 'powershell' })
    ).toBe('omni claude-teams')
    expect(applyLocalOmniConsoleCliLauncher('/usr/local/bin/omni claude-teams', args)).toBe(
      '/usr/local/bin/omni claude-teams'
    )
    expect(applyLocalOmniConsoleCliLauncher("'/opt/omni' claude-teams", args)).toBe(
      "'/opt/omni' claude-teams"
    )
    expect(applyLocalOmniConsoleCliLauncher('claude --model opus', args)).toBe(
      'claude --model opus'
    )
    expect(applyLocalOmniConsoleCliLauncher('omnibus claude-teams', args)).toBe(
      'omnibus claude-teams'
    )
    expect(applyLocalOmniConsoleCliLauncher('', args)).toBe('')
  })
})

describe('normalizeOmniConsoleCliLauncherForMatch', () => {
  it('folds an absolute launcher, quoted or bare, back to its command name', () => {
    expect(
      normalizeOmniConsoleCliLauncherForMatch(
        `${QUOTED} claude-teams '--dangerously-skip-permissions'`
      )
    ).toBe("omni claude-teams '--dangerously-skip-permissions'")
    expect(normalizeOmniConsoleCliLauncherForMatch(`${LAUNCHER} claude-teams`)).toBe(
      'omni claude-teams'
    )
    expect(
      normalizeOmniConsoleCliLauncherForMatch(
        '/home/sal/.config/omni-dev/cli/bin/omni-dev claude-teams'
      )
    ).toBe('omni-dev claude-teams')
  })

  it('leaves bare names and other executables alone', () => {
    expect(normalizeOmniConsoleCliLauncherForMatch('omni claude-teams')).toBe('omni claude-teams')
    expect(normalizeOmniConsoleCliLauncherForMatch('/usr/local/bin/claude --resume')).toBe(
      '/usr/local/bin/claude --resume'
    )
    expect(normalizeOmniConsoleCliLauncherForMatch('')).toBe('')
  })
})
