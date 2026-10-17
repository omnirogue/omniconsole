import { beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildSourceControlAgentDeliveryPlan } from './buildSourceControlAgentDeliveryPlan'

let settings = getDefaultSettings('/tmp')
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings }) } }))

const args = {
  selectedAgent: 'codex' as const,
  commandInput: 'Review changes',
  agentArgs: '-m terminal-model',
  promptDelivery: 'auto-submit' as const,
  detectedAgents: ['codex' as const],
  connectionUnavailable: false,
  launchPlatform: 'darwin' as const
}

beforeEach(() => {
  settings = {
    ...getDefaultSettings('/tmp'),
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault: false,
    nativeChatSessionOptions: {
      codex: { model: 'gpt-5.2-codex', valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } } }
    }
  }
})

it('previews saved effort without substituting the terminal model', () => {
  const plan = buildSourceControlAgentDeliveryPlan(args)
  expect(plan.status).toBe('success')
  if (plan.status !== 'success') {
    throw new Error('Expected a successful preview')
  }
  expect(plan.commandLabel).toContain('model_reasoning_effort=medium')
  expect(plan.commandLabel).toContain("'-m' 'terminal-model'")
  expect(plan.commandLabel).not.toContain('gpt-5.2-codex')
})

it.each(['--profile work', '-c model_reasoning_effort=low'])(
  'previews explicit dialog arguments rather than saved effort: %s',
  (agentArgs) => {
    const plan = buildSourceControlAgentDeliveryPlan({ ...args, agentArgs })
    expect(plan.status).toBe('success')
    if (plan.status !== 'success') {
      throw new Error('Expected a successful preview')
    }
    expect(plan.commandLabel).not.toContain('model_reasoning_effort=medium')
  }
)

it.each(['environment', 'custom'] as const)(
  'keeps the preview aligned with an explicit %s choice',
  (selection) => {
    if (selection === 'environment') {
      settings.agentDefaultEnv = { codex: { OPENAI_MODEL: 'configured-model' } }
    }
    if (selection === 'custom') {
      settings.agentCmdOverrides = { codex: 'custom-codex' }
    }
    const plan = buildSourceControlAgentDeliveryPlan(args)
    expect(plan.status).toBe('success')
    if (plan.status !== 'success') {
      throw new Error('Expected a successful preview')
    }
    expect(plan.commandLabel).not.toContain('model_reasoning_effort')
  }
)
