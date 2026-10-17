import { describe, expect, it, vi } from 'vitest'
import { resolveNewAgentSessionDefaults } from './new-agent-session-defaults'

describe('effort-only new-session defaults', () => {
  const input = {
    agent: 'codex' as const,
    workspacePath: '/project',
    options: { effort: 'low' },
    readFile: vi.fn(async () => null)
  }

  it('preserves effort without choosing a model or reading provider configuration', async () => {
    input.readFile.mockClear()
    await expect(resolveNewAgentSessionDefaults(input)).resolves.toEqual({ effort: 'low' })
    await expect(
      resolveNewAgentSessionDefaults({ ...input, agentArgs: '-m terminal-model' })
    ).resolves.toEqual({ effort: 'low' })
    expect(input.readFile).not.toHaveBeenCalled()
  })

  it.each([
    { agentArgs: '-c model_reasoning_effort=medium' },
    { agentArgs: '-cmodel_reasoning_effort=medium' },
    { agentArgs: '--config=model_reasoning_effort=medium' },
    { agentArgs: '--profile intentional-high' },
    { commandOverride: 'custom-codex' },
    { env: { OPENAI_MODEL: 'intentional-model' } }
  ])('defers to the execution host configuration %j', async (override) => {
    await expect(resolveNewAgentSessionDefaults({ ...input, ...override })).resolves.toBeUndefined()
  })

  it('defers to a Claude effort environment variable', async () => {
    await expect(
      resolveNewAgentSessionDefaults({
        ...input,
        agent: 'claude',
        env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' }
      })
    ).resolves.toBeUndefined()
  })

  it('retains model-bearing actor preference precedence', async () => {
    await expect(
      resolveNewAgentSessionDefaults({
        ...input,
        options: { model: 'actor-model', effort: 'medium' },
        agentArgs: '-c model_reasoning_effort=low'
      })
    ).resolves.toEqual({ model: 'actor-model', effort: 'medium' })
  })
})
