import { GEMINI_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-gemini-cursor'
import {
  getCommitMessageAgentSpec,
  type CommitMessageAgentSpec,
  type CommitMessageModel
} from './commit-message-agent-spec'
import { GROK_MODEL_LIST_ARGS, parseGrokModelList } from './grok-model-list-probe'
import { OMP_MODEL_LIST_ARGS, parseOmpModelList } from './omp-model-list-probe'
import type { TuiAgent } from './tui-agent'

/** Why: model discovery reads only these fields; excluding the prompt-delivery
 *  half is what keeps a probe-only agent out of the commit-message registry. */
export type AgentModelProbeSpec = Omit<CommitMessageAgentSpec, 'promptDelivery' | 'buildArgs'>

// Why `--version`: the Gemini CLI has no model-list command; a zero exit proves the binary runs on
// this host, and the catalog, the one list launches validate against, supplies the models.
function geminiModelsAfterVersionProbe(stdout: string): CommitMessageModel[] {
  return stdout.trim()
    ? GEMINI_SESSION_OPTION_CATALOG.models.map(({ id, label, isDefault }) => ({
        id,
        label,
        ...(isDefault ? { isDefault } : {})
      }))
    : []
}

const GEMINI_DEFAULT_MODEL =
  GEMINI_SESSION_OPTION_CATALOG.models.find((model) => model.isDefault) ??
  GEMINI_SESSION_OPTION_CATALOG.models[0]

/** Agents that support model discovery but are not commit-message agents. */
const MODEL_DISCOVERY_ONLY_SPECS: Partial<Record<TuiAgent, AgentModelProbeSpec>> = {
  omp: {
    id: 'omp',
    label: 'Oh My Pi',
    binary: 'omp',
    modelSource: 'dynamic',
    modelDiscovery: { binary: 'omp', args: OMP_MODEL_LIST_ARGS, parse: parseOmpModelList },
    models: [],
    defaultModelId: ''
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    binary: 'grok',
    modelSource: 'dynamic',
    modelDiscovery: {
      binary: 'grok',
      args: GROK_MODEL_LIST_ARGS,
      parse: parseGrokModelList
    },
    // Why: empty so a failed probe degrades to the catalog seed instead of a
    // second model list here that can drift from it.
    models: [],
    defaultModelId: 'grok-4.6'
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    binary: 'gemini',
    modelSource: 'dynamic',
    modelDiscovery: {
      binary: 'gemini',
      args: ['--version'],
      parse: geminiModelsAfterVersionProbe
    },
    // Why: empty so a CLI that does not run lists nothing, and no second list can drift from
    // the catalog.
    models: [],
    defaultModelId: GEMINI_DEFAULT_MODEL.id
  }
}

export function getAgentModelProbeSpec(agentId: TuiAgent): AgentModelProbeSpec | undefined {
  return getCommitMessageAgentSpec(agentId) ?? MODEL_DISCOVERY_ONLY_SPECS[agentId]
}
