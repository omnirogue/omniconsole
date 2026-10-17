import { removeAgentArgOption } from './agent-session-option-agent-args'
import { hasFlag } from './agent-cli-flag-detection'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

/**
 * OpenCode takes `--model provider/model` at launch (docs: opencode.ai/docs/cli). Models are
 * whatever the merged config declares, so the catalog seeds none and accepts any id the
 * launcher hands it; the Local Ollama route declares the model in its launch config.
 */
export const OPENCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: [],
  supportsWorkerLaunchPreferences: true,
  discoveredModelsAreAuthoritative: true,
  preserveExplicitModelSelection: true,
  modelApply: {
    launchArgs: (value) => ['--model', String(value)],
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--model', '-m']),
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--model', '-m']),
    // Why: OpenCode's TUI switches models through its own picker; no typed setter is documented.
    midSession: { kind: 'unsupported' }
  }
}
