import { removeAgentArgOption } from './agent-session-option-agent-args'
import { hasFlag } from './agent-cli-flag-detection'
import type { CommitMessageModelCapability } from './commit-message-agent-spec'
import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import { parseOmpModelList } from './omp-model-list-probe'

const THINKING_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

function ompEffort(levels: string[]): CatalogOption {
  return {
    // Why: launch preferences only persist the model/effort/mode option ids.
    id: 'effort',
    label: 'Thinking',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: levels.map((value) => ({ value, label: THINKING_LABELS[value] ?? value })),
      defaultValue: levels.includes('high')
        ? 'high'
        : levels.includes('medium')
          ? 'medium'
          : levels[Math.floor((levels.length - 1) / 2)]
    },
    apply: {
      launchArgs: (value) => ['--thinking', String(value)],
      agentArgsOverride: (tokens) => hasFlag(tokens, ['--thinking']),
      removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--thinking']),
      // Why: an untouched picker must preserve OMP's configured thinking default.
      inheritCliDefault: true,
      // Why: OMP documents no live thinking setter; never pretend a launch flag is one.
      midSession: { kind: 'unsupported' }
    }
  }
}

export function createOmpCatalogModel(model: CommitMessageModelCapability): CatalogModel {
  return {
    ...model,
    options: model.reasoning === true && model.thinking?.length ? [ompEffort(model.thinking)] : []
  }
}

export const OMP_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [],
  supportsWorkerLaunchPreferences: true,
  // Why: a discovered id absent from launch's static seed still needs launch-safe
  // effort levels (mirrors GROK_SESSION_OPTION_CATALOG's unknownModelOptions comment);
  // the picker itself still only offers each model's own real ladder via
  // `createOmpCatalogModel`, this is only what validation/argv accept for that id.
  unknownModelOptions: [ompEffort(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])],
  discoveredModelsAreAuthoritative: true,
  preserveExplicitModelSelection: true,
  modelApply: {
    // OMP and its ACP config both use provider/model, including nested OpenRouter ids.
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model', '--provider']),
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model', '--provider']),
    // OMP's TUI accepts a selector only with /switch; /model opens its native picker.
    midSession: {
      kind: 'command',
      build: (value) => `/switch ${String(value)}`,
      pickerCommand: '/model',
      detectAgentInteraction: 'omp-model-switch-confirmation'
    }
  },
  listModels: {
    command: 'omp models ls --json',
    parse: (stdout) => parseOmpModelList(stdout).map(createOmpCatalogModel)
  }
}
