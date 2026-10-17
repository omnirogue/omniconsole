import { afterEach, describe, expect, it } from 'vitest'
import { setLocalOmniConsoleCliLauncher } from './omniconsole-cli-launcher'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { quoteStartupArg } from './tui-agent-startup-shell'

const LAUNCHER = '/Users/maintainer/Applications/OmniConsole.app/Contents/Resources/bin/omni'
const QUOTED = quoteStartupArg(LAUNCHER, 'posix')

afterEach(() => {
  setLocalOmniConsoleCliLauncher(null)
})

describe('resolveAgentLaunchCommand with the OmniConsole CLI launcher registered', () => {
  it('launches Agent Teams through the bundled launcher on a local POSIX host', () => {
    setLocalOmniConsoleCliLauncher(LAUNCHER)
    const local = resolveAgentLaunchCommand({
      agent: 'claude-agent-teams',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix',
      agentArgs: '--dangerously-skip-permissions'
    })
    expect(local).toMatchObject({
      ok: true,
      command: `${QUOTED} claude-teams '--dangerously-skip-permissions'`,
      commandWithoutSessionOptions: `${QUOTED} claude-teams '--dangerously-skip-permissions'`
    })
    const bypassing = resolveAgentLaunchCommand({
      agent: 'claude-agent-teams',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix',
      bypassShellFunctions: true
    })
    expect(bypassing).toMatchObject({ ok: true, command: `command ${QUOTED} claude-teams` })
  })

  it('keeps the bare name for remote hosts, overrides and other agents', () => {
    setLocalOmniConsoleCliLauncher(LAUNCHER)
    expect(
      resolveAgentLaunchCommand({
        agent: 'claude-agent-teams',
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        isRemote: true
      })
    ).toMatchObject({ ok: true, command: 'omni claude-teams' })
    expect(
      resolveAgentLaunchCommand({
        agent: 'claude-agent-teams',
        cmdOverrides: { 'claude-agent-teams': 'omni claude-teams --teammate-mode auto' },
        platform: 'darwin',
        shell: 'posix'
      })
    ).toMatchObject({ ok: true, command: 'omni claude-teams --teammate-mode auto' })
    expect(
      resolveAgentLaunchCommand({
        agent: 'claude',
        cmdOverrides: {},
        platform: 'darwin',
        shell: 'posix'
      })
    ).toMatchObject({ ok: true, command: 'claude' })
  })

  it('stays byte-identical to the bare launch when no launcher is registered', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'claude-agent-teams',
        cmdOverrides: {},
        platform: 'darwin',
        shell: 'posix'
      })
    ).toMatchObject({ ok: true, command: 'omni claude-teams' })
  })

  it('carries the launcher through the startup plan the Attention favourites use', () => {
    setLocalOmniConsoleCliLauncher(LAUNCHER)
    const plan = buildAgentStartupPlan({
      agent: 'claude-agent-teams',
      prompt: '',
      cmdOverrides: {},
      platform: 'darwin',
      allowEmptyPromptLaunch: true,
      agentArgs: '--dangerously-skip-permissions'
    })
    expect(plan?.launchCommand).toBe(`${QUOTED} claude-teams '--dangerously-skip-permissions'`)
    expect(plan?.expectedProcess).toBe('claude')
  })
})
