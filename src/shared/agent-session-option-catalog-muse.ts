import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

// Muse Code's public CLI contract: https://dev.meta.ai/docs/muse-code
// Verified against `muse --help`: --model and --reasoning-effort (alias --effort).
const MUSE_EFFORT: CatalogOption = {
  id: 'effort',
  label: 'Effort',
  category: 'thought_level',
  kind: {
    type: 'select',
    choices: [
      { value: 'none', label: 'None' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
      { value: 'ultra', label: 'Ultra' }
    ],
    defaultValue: 'high'
  },
  apply: {
    inheritCliDefault: true,
    launchArgs: (value) => ['--reasoning-effort', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--reasoning-effort', '--effort']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--reasoning-effort', '--effort']),
    midSession: { kind: 'agent-picker', command: '/effort' }
  }
}

export const MUSE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [
    { id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full', options: [MUSE_EFFORT] },
    { id: 'muse-wonder-1.0', label: 'Muse Wonder', options: [MUSE_EFFORT] },
    { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', options: [MUSE_EFFORT] },
    { id: 'muse-spark-1.2', label: 'Muse Spark 1.2', isDefault: true, options: [MUSE_EFFORT] }
  ],
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model']),
    midSession: { kind: 'agent-picker', command: '/model' }
  }
}
