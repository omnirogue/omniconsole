import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import {
  automationLaunchAccountEnv,
  normalizeAutomationLaunchPreferences
} from './automation-launch-preferences'

describe('automation launch preferences', () => {
  it.each([
    [
      'codex',
      'gpt-6-astra',
      'xhigh',
      '-m old -c model_reasoning_effort=low --sandbox read-only',
      ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh']
    ],
    [
      'claude',
      'fable',
      'max',
      '--model old --effort low --verbose',
      ['--model', 'fable', '--effort', 'max']
    ]
  ] as const)(
    'overrides %s defaults with catalog flags',
    (agent, model, effort, agentArgs, expected) => {
      const result = resolveAgentLaunchCommand({
        agent,
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        agentArgs,
        sessionOptions: { model, effort },
        sessionOptionsOverrideAgentArgs: true
      })
      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      const tokens = tokenizeStartupCommand(result.command, 'posix')
      expect(tokens.ok && tokens.tokens.slice(-expected.length)).toEqual(expected)
      expect(result.command).not.toContain('old')
      expect(result.command).not.toContain('low')
      expect(result.command).toContain(agent === 'codex' ? '--sandbox' : '--verbose')
    }
  )

  it('inherits the model when only effort is selected, and effort when only model is selected', () => {
    const launch = (sessionOptions: Record<string, string>) =>
      resolveAgentLaunchCommand({
        agent: 'codex',
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        agentArgs: '-m existing -c model_reasoning_effort=high',
        sessionOptions,
        sessionOptionsOverrideAgentArgs: true
      })
    expect(launch({ effort: 'xhigh' })).toMatchObject({
      ok: true,
      appliedSessionOptions: { effort: 'xhigh' }
    })
    const model = launch({ model: 'gpt-6-astra' })
    expect(model.ok && model.command).toContain('model_reasoning_effort=high')
    const effort = launch({ effort: 'xhigh' })
    expect(effort.ok && effort.command).toContain('existing')
  })

  it('pins the existing managed-home mechanism and refuses missing or foreign homes', () => {
    const settings = {
      codexManagedAccounts: [
        {
          id: 'a',
          email: 'sal@example.com',
          managedHomePath: '/managed/a',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    }
    expect(automationLaunchAccountEnv(settings, 'codex', { codexAccountId: 'a' })).toEqual({
      CODEX_HOME: '/managed/a'
    })
    expect(() =>
      automationLaunchAccountEnv(settings, 'codex', { codexAccountId: 'missing' })
    ).toThrow('no longer available')
    expect(() =>
      automationLaunchAccountEnv(settings, 'codex', { codexAccountId: 'a' }, true)
    ).toThrow('account-owning runtime')
    expect(normalizeAutomationLaunchPreferences('codex', null)).toBeUndefined()
  })
})
