import { describe, expect, it } from 'vitest'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentStartupPlan } from './tui-agent-startup'

const settings =
  '/Users/maintainer/Library/Application Support/OmniConsole/claude-thread-memory/k/settings.json'
const pinnedFlags = [['--settings', settings]] as const
const pinned = `claude '--settings' '${settings}'`

function resolve(overrides: Partial<Parameters<typeof resolveAgentLaunchCommand>[0]> = {}) {
  const result = resolveAgentLaunchCommand({
    agent: 'claude',
    cmdOverrides: {},
    platform: 'darwin',
    shell: 'posix',
    pinnedFlags,
    ...overrides
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

describe('resolveAgentLaunchCommand pinned flags', () => {
  it.each<[AgentStartupShell, NodeJS.Platform, string]>([
    ['posix', 'darwin', `claude '--settings' '${settings}'`],
    ['powershell', 'win32', `claude '--settings' '${settings}'`],
    ['cmd', 'win32', `claude "--settings" "${settings}"`]
  ])('quotes a path with spaces for %s', (shell, platform, expected) => {
    expect(resolve({ shell, platform }).command).toBe(expected)
  })

  it('keeps the flag in the resume command, unlike picker options', () => {
    const result = resolve({ sessionOptions: { model: 'opus' }, agentArgs: '--verbose' })

    expect(result.command).toMatch(new RegExp(`^${pinned} '--model' 'opus' .*'--verbose'$`))
    expect(result.commandWithoutSessionOptions).toBe(`${pinned} '--verbose'`)
  })

  it("leaves a flag the person's own arguments or command override already pass", () => {
    expect(resolve({ agentArgs: '--settings /mine.json' }).command).toBe(
      "claude '--settings' '/mine.json'"
    )
    expect(resolve({ agentArgs: '--settings=/mine.json' }).command).toBe(
      "claude '--settings=/mine.json'"
    )
    expect(resolve({ cmdOverrides: { claude: 'claude --settings /mine.json' } }).command).toBe(
      'claude --settings /mine.json'
    )
  })

  it('adds the flag after a pinned account and ahead of user arguments', () => {
    const result = resolve({
      bypassShellFunctions: true,
      accountConfigEnv: { CLAUDE_CONFIG_DIR: '/pool/slot-2' },
      agentArgs: '--verbose'
    })

    expect(result.command).toBe(`CLAUDE_CONFIG_DIR='/pool/slot-2' command ${pinned} '--verbose'`)
  })

  it('carries the flag into the sleeping-session launch config', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix',
      allowEmptyPromptLaunch: true,
      pinnedFlags
    })

    expect(plan?.launchCommand).toBe(pinned)
    expect(plan?.launchConfig.agentCommand).toBe(pinned)
  })
})
