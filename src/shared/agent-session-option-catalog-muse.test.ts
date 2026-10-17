import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { MUSE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-muse'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { isHeadlessOneShotAgentCommand } from './agent-headless-command'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('Muse Code launch', () => {
  it('resolves the picker selection into Muse CLI flags', () => {
    expect(getAgentSessionOptionCatalog('muse')).toBe(MUSE_SESSION_OPTION_CATALOG)
    expect(
      resolveAgentSessionOptionLaunch('muse', { model: 'muse-spark-1.2', effort: 'xhigh' })
    ).toEqual({
      args: ['--model', 'muse-spark-1.2', '--reasoning-effort', 'xhigh'],
      appliedValues: { model: 'muse-spark-1.2', effort: 'xhigh' }
    })
  })

  it('preserves the CLI configuration when effort is unselected', () => {
    expect(resolveAgentSessionOptionLaunch('muse', { model: 'muse-spark-1.2' }).args).toEqual([
      '--model',
      'muse-spark-1.2'
    ])
    expect(resolveAgentSessionOptionLaunch('muse', undefined)).toEqual({
      args: [],
      appliedValues: {}
    })
  })

  it.each(['--effort=low', '--reasoning-effort=low'])('honors a configured %s override', (flag) => {
    expect(
      resolveAgentSessionOptionLaunch('muse', { model: 'muse-spark-1.2', effort: 'high' }, [flag])
    ).toEqual({
      args: ['--model', 'muse-spark-1.2', '--reasoning-effort', 'high'],
      appliedValues: { model: 'muse-spark-1.2' }
    })
  })

  it.each([
    ['linux', undefined, '--version', "muse -- ' --version'"],
    ['win32', undefined, 'exec', "muse -- ' exec'"],
    ['win32', 'cmd', 'help', 'muse -- " help"']
  ] as const)(
    'keeps a %s %s prompt out of option/subcommand parsing',
    (platform, shell, prompt, expected) => {
      expect(
        buildAgentStartupPlan({ agent: 'muse', prompt, cmdOverrides: {}, platform, shell })
          ?.launchCommand
      ).toBe(expected)
    }
  )

  it('places the positional prompt after the selected model and effort', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'muse',
        prompt: 'exec',
        cmdOverrides: {},
        agentArgs: '--model muse-spark-1.2 --reasoning-effort high',
        platform: 'darwin'
      })?.launchCommand
    ).toBe("muse '--model' 'muse-spark-1.2' '--reasoning-effort' 'high' -- ' exec'")
  })

  it('recognizes exec/serve as headless without treating prompts or flag values as subcommands', () => {
    expect(
      isHeadlessOneShotAgentCommand('muse', ['muse', '--model', 'muse-spark-1.2', 'exec', 'hello'])
    ).toBe(true)
    expect(isHeadlessOneShotAgentCommand('muse', ['muse', 'serve'])).toBe(true)
    expect(isHeadlessOneShotAgentCommand('muse', ['muse', '--model', 'exec'])).toBe(false)
    expect(isHeadlessOneShotAgentCommand('muse', ['muse', '--', 'exec'])).toBe(false)
    expect(
      isHeadlessOneShotAgentCommand('muse', ['muse', '--worktree', 'existing', 'resume', '--last'])
    ).toBe(false)
  })
})
