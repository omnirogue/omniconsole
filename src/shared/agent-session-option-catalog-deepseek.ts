import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

const DEEPSEEK_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' }
    ],
    defaultValue: 'high'
  },
  apply: {
    inheritCliDefault: true,
    launchArgs: (value) => ['--reasoning-effort', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--reasoning-effort', '--effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--reasoning-effort', '--effort']),
    midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` }
  }
}

export const DEEPSEEK_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro (deepseek-v4-pro)',
      description: 'DeepSeek V4 Pro flagship general & coding model (1M context)',
      isDefault: true,
      options: [DEEPSEEK_EFFORT]
    },
    {
      id: 'deepseek-flash',
      label: 'DeepSeek V4.1 Flash (deepseek-flash)',
      description: 'DeepSeek V4.1 Flash high-speed multimodal & coding model (1M context)',
      options: [DEEPSEEK_EFFORT]
    },
    {
      id: 'deepseek-v4.1',
      label: 'DeepSeek V4.1 (deepseek-v4.1)',
      description: 'DeepSeek V4.1 frontier reasoning & coding model',
      options: [DEEPSEEK_EFFORT]
    },
    {
      id: 'deepseek-r2',
      label: 'DeepSeek R2 (deepseek-r2)',
      description: 'DeepSeek R2 next-generation deep reasoning model',
      options: [DEEPSEEK_EFFORT]
    },
    {
      id: 'deepseek-v3.2',
      label: 'DeepSeek V3.2 (deepseek-v3.2)',
      description: 'DeepSeek V3.2 general & coding model',
      options: [DEEPSEEK_EFFORT]
    },
    {
      id: 'deepseek-r1',
      label: 'DeepSeek R1 (deepseek-r1)',
      description: 'DeepSeek R1 chain-of-thought reasoning model',
      options: [DEEPSEEK_EFFORT]
    },
    {
      id: 'deepseek-chat',
      label: 'DeepSeek Chat (deepseek-chat)',
      description: 'DeepSeek standard chat endpoint alias',
      options: [DEEPSEEK_EFFORT]
    },
    {
      id: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner (deepseek-reasoner)',
      description: 'DeepSeek standard reasoning endpoint alias',
      options: [DEEPSEEK_EFFORT]
    }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['-m', '--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['-m', '--model']),
    midSession: { kind: 'command', build: (value) => `/model ${String(value)}` }
  }
}
