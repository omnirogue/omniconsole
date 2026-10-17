import type { LocalWorkflowRoute } from './local-workflow-seats'
import { claudeLongContextModel } from './workflow-model-context-window'

const PROVIDER: Record<LocalWorkflowRoute, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  ollama: 'Ollama'
}

/** Provider name for a workflow route, e.g. "Codex". Brand names are not translated. */
export function localWorkflowProviderLabel(agent: LocalWorkflowRoute): string {
  return PROVIDER[agent]
}

/**
 * Friendly model name for a resolved model id, e.g. "Claude Opus 5", "Claude Opus 5.5 (1M context)",
 * "GPT-5.6 Sol", "Grok 4.6", "Gemini 3.8 Flash". Unknown ids fall back to the provider plus the
 * raw id.
 */
export function localWorkflowModelLabel(agent: LocalWorkflowRoute, model: string): string {
  const id = model.trim().toLowerCase()
  const claude = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(id)
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1)
    const version = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2]
    return `Claude ${family} ${version}${claudeLongContextModel(id) ? ' (1M context)' : ''}`
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?/.exec(id)
  if (gpt) {
    const tier = gpt[2] ? ` ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}` : ''
    return `GPT-${gpt[1]}${tier}`
  }
  const grok = /^grok-(\d+(?:\.\d+)?)/.exec(id)
  if (grok) {
    return `Grok ${grok[1]}`
  }
  const gemini = /^gemini-(\d+(?:\.\d+)?)(?:-([a-z]+))?/.exec(id)
  if (gemini) {
    const tier = gemini[2] ? ` ${gemini[2][0].toUpperCase()}${gemini[2].slice(1)}` : ''
    return `Gemini ${gemini[1]}${tier}`
  }
  return model.trim() ? `${PROVIDER[agent]} · ${model.trim()}` : PROVIDER[agent]
}
