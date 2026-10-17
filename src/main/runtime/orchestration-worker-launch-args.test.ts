import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import {
  durableWorkerLaunchConfig,
  orchestrationWorkerLaunchArgs
} from './orchestration-worker-launch-args'

const launchCause = { trigger: 'orchestration-worker' } as const

describe('supervised Codex startup arguments', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)(
    'preserves multiple config keys and inserts the worker override before -- on %s',
    (shell) => {
      const result = orchestrationWorkerLaunchArgs({
        agent: 'codex',
        launchCause,
        shell,
        agentArgs:
          '--model chosen -c model_reasoning_effort=high --config features.web_search=true -- -c check_for_update_on_startup=true'
      })
      expect(tokenizeStartupCommand(result, shell)).toMatchObject({
        ok: true,
        tokens: [
          '--model',
          'chosen',
          '-c',
          'model_reasoning_effort=high',
          '--config',
          'features.web_search=true',
          '-c',
          'check_for_update_on_startup=false',
          '--',
          '-c',
          'check_for_update_on_startup=true'
        ]
      })
    }
  )

  it.each([
    '-c check_for_update_on_startup=true',
    '--config check_for_update_on_startup=true',
    '-ccheck_for_update_on_startup=true',
    '-c=check_for_update_on_startup=true',
    '--config=check_for_update_on_startup=true',
    '-c "check_for_update_on_startup = true"'
  ])('overrides only the updater key in %s', (agentArgs) => {
    const result = orchestrationWorkerLaunchArgs({
      agent: 'codex',
      launchCause,
      shell: 'posix',
      agentArgs: `${agentArgs} --config check_for_update_on_startup_other=true`
    })
    expect(tokenizeStartupCommand(result, 'posix')).toMatchObject({
      ok: true,
      tokens: [
        '--config',
        'check_for_update_on_startup_other=true',
        '-c',
        'check_for_update_on_startup=false'
      ]
    })
  })

  it.each(['orchestration-worker', 'hibernation-wake'] as const)(
    'retains selected model, effort and account through the real %s launch planner',
    (trigger) => {
      const plan = buildAgentStartupPlan({
        agent: 'codex',
        platform: 'darwin',
        shell: 'posix',
        prompt: '',
        allowEmptyPromptLaunch: true,
        cmdOverrides: {},
        agentEnv: { CODEX_HOME: '/verified/account/home' },
        agentArgs: orchestrationWorkerLaunchArgs({
          agent: 'codex',
          launchCause: { trigger },
          shell: 'posix',
          agentArgs: '--model old -c model_reasoning_effort=low --config features.web_search=true'
        }),
        sessionOptions: { model: 'gpt-6-astra', effort: 'high' },
        sessionOptionsOverrideAgentArgs: true
      })
      expect(plan).not.toBeNull()
      expect(plan?.sessionOptions).toEqual({ model: 'gpt-6-astra', effort: 'high' })
      expect(plan?.env).toEqual({ CODEX_HOME: '/verified/account/home' })
      expect(plan?.launchConfig.agentEnv).toEqual({ CODEX_HOME: '/verified/account/home' })
      expect(plan?.launchCommand).toContain("'check_for_update_on_startup=false'")
      expect(plan?.launchCommand).toContain("'features.web_search=true'")
      expect(plan?.launchCommand).not.toContain('model_reasoning_effort=low')
      // Why: the suppression is scoped to this launch. The durable record a later resume replays
      // verbatim keeps the operator's own arguments and command.
      const durable = durableWorkerLaunchConfig(plan?.launchConfig, {
        agent: 'codex',
        launchCause: { trigger },
        shell: 'posix',
        agentArgs: '--model old -c model_reasoning_effort=low --config features.web_search=true'
      })
      expect(durable?.agentArgs).toBe(
        '--model old -c model_reasoning_effort=low --config features.web_search=true'
      )
      expect(durable?.agentCommand).not.toContain('check_for_update_on_startup')
      expect(durable?.agentCommand).toContain("'features.web_search=true'")
      expect(durable?.agentCommand).toContain("'model_reasoning_effort=low'")
    }
  )

  it('restores the operator updater setting in the durable record and never touches other launches', () => {
    const own = '-c check_for_update_on_startup=true --model "my model"'
    const managed = { agent: 'codex', launchCause, shell: 'posix', agentArgs: own } as const
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      platform: 'darwin',
      shell: 'posix',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      agentArgs: orchestrationWorkerLaunchArgs(managed)
    })
    expect(plan?.launchConfig.agentCommand).toContain("'check_for_update_on_startup=false'")
    const durable = durableWorkerLaunchConfig(plan?.launchConfig, managed)
    expect(durable?.agentArgs).toBe(own)
    expect(durable?.agentCommand).toContain("'check_for_update_on_startup=true'")
    expect(durable?.agentCommand).not.toContain('check_for_update_on_startup=false')
    expect(durable?.agentCommand).toContain("'my model'")
    // A human launch or another provider is returned as the same object.
    const human = { ...plan!.launchConfig }
    expect(
      durableWorkerLaunchConfig(human, { ...managed, launchCause: { trigger: 'person-reveal' } })
    ).toBe(human)
    expect(durableWorkerLaunchConfig(human, { ...managed, agent: 'claude' })).toBe(human)
    expect(durableWorkerLaunchConfig(undefined, managed)).toBeUndefined()
  })

  it('leaves a command it did not build alone', () => {
    const managed = { agent: 'codex', launchCause, shell: 'posix', agentArgs: '' } as const
    const foreign = { agentCommand: 'codex --yolo', agentArgs: '--yolo' }
    expect(durableWorkerLaunchConfig(foreign, managed)).toEqual(foreign)
  })

  it('leaves human launches and other providers byte-for-byte unchanged', () => {
    const agentArgs = '-c check_for_update_on_startup=true  --model "my model"'
    for (const trigger of [
      undefined,
      'person-reveal',
      'automation',
      'session-resume',
      'agent-session-resume'
    ] as const) {
      expect(
        orchestrationWorkerLaunchArgs({
          agent: 'codex',
          shell: 'posix',
          agentArgs,
          launchCause: trigger ? { trigger } : undefined
        })
      ).toBe(agentArgs)
    }
    expect(
      orchestrationWorkerLaunchArgs({
        agent: 'claude',
        shell: 'posix',
        agentArgs,
        launchCause
      })
    ).toBe(agentArgs)
  })

  it('rejects malformed worker arguments instead of silently omitting the override', () => {
    expect(() =>
      orchestrationWorkerLaunchArgs({
        agent: 'codex',
        launchCause,
        shell: 'posix',
        agentArgs: '--model "unclosed'
      })
    ).toThrow('CLI arguments are invalid')
  })
})
