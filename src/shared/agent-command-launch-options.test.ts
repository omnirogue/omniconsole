import { describe, expect, it } from 'vitest'
import {
  agentLaunchOptionsFromCommand,
  withAgentLaunchOptions
} from './agent-command-launch-options'

describe('agent launch options from a command line', () => {
  it('reads Claude model and effort in either flag form', () => {
    expect(
      agentLaunchOptionsFromCommand(
        'claude',
        'claude --dangerously-skip-permissions --model opus --effort xhigh Read the brief'
      )
    ).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(agentLaunchOptionsFromCommand('claude', "claude '--model=sonnet'")).toEqual({
      model: 'sonnet'
    })
    expect(agentLaunchOptionsFromCommand('claude', 'claude -- --model opus')).toEqual({})
  })

  it('reads Codex model and reasoning effort', () => {
    expect(
      agentLaunchOptionsFromCommand(
        'codex',
        'node /opt/codex -m gpt-5.5 -c model_reasoning_effort=high --no-daemon'
      )
    ).toEqual({ model: 'gpt-5.5', effort: 'high' })
    expect(
      agentLaunchOptionsFromCommand('codex', 'codex --config="model_reasoning_effort=xhigh"')
    ).toEqual({ effort: 'xhigh' })
  })

  it('ignores values with shell metacharacters', () => {
    expect(agentLaunchOptionsFromCommand('claude', 'claude --model $(rm) --effort a;b')).toEqual({})
  })

  it('adds only the missing flags to a sleeping record', () => {
    const config = {
      agentCommand: "command claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    }
    expect(withAgentLaunchOptions(config, 'claude', { model: 'opus', effort: 'xhigh' })).toEqual({
      agentCommand: "command claude '--dangerously-skip-permissions' --model opus --effort xhigh",
      agentArgs: '--dangerously-skip-permissions --model opus --effort xhigh',
      agentEnv: {}
    })
    const pinned = { ...config, agentArgs: '--model sonnet', agentCommand: undefined }
    expect(withAgentLaunchOptions(pinned, 'claude', { model: 'opus', effort: 'high' })).toEqual({
      ...pinned,
      agentArgs: '--model sonnet --effort high'
    })
    expect(
      withAgentLaunchOptions({ agentArgs: '', agentEnv: {} }, 'codex', { effort: 'high' })
    ).toEqual({ agentArgs: '-c model_reasoning_effort=high', agentEnv: {} })
    expect(withAgentLaunchOptions(config, 'claude', undefined)).toBe(config)
  })
})
