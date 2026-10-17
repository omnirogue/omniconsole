import type { TuiAgent } from './tui-agent'

/**
 * Which model family a seat draws on. Independence between seats is judged by lineage, not by
 * product name: two seats of the same mind are not a second opinion. A seat this table cannot
 * place has lineage `unknown`, which is never independent and never decides — the safe answer to
 * "is this safe?" (estate rule; the hub's formation/lineage table).
 */
export type ModelLineage =
  | 'anthropic'
  | 'openai'
  | 'xai'
  | 'google'
  | 'moonshot'
  | 'alibaba'
  | 'deepseek'
  | 'meta'
  | 'mistral'
  | 'zhipu'
  | 'minimax'
  | 'nvidia'
  | 'cohere'
  | 'ai21'
  | 'amazon'
  | 'bytedance'
  | 'xiaomi'
  | 'unknown'

const OPENROUTER_LINEAGES: Record<string, ModelLineage> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'x-ai': 'xai',
  google: 'google',
  moonshotai: 'moonshot',
  qwen: 'alibaba',
  deepseek: 'deepseek',
  'meta-llama': 'meta',
  mistralai: 'mistral',
  'z-ai': 'zhipu',
  minimax: 'minimax',
  nvidia: 'nvidia',
  cohere: 'cohere',
  ai21: 'ai21',
  amazon: 'amazon',
  bytedance: 'bytedance',
  xiaomi: 'xiaomi'
}

/**
 * Ollama tags name the open-weight family (`qwen3:8b`, `hf.co/org/Llama-3.3-GGUF:Q4_K_M`). Only
 * the model name is read, never the registry or the publisher in front of it.
 */
const OLLAMA_LINEAGES: readonly (readonly [RegExp, ModelLineage])[] = [
  [/^(llama|codellama|llava)/, 'meta'],
  [/^(qwen|qwq)/, 'alibaba'],
  [/^deepseek/, 'deepseek'],
  [/^(mistral|mixtral|codestral|devstral|magistral|ministral)/, 'mistral'],
  [/^(gemma|codegemma)/, 'google'],
  [/^gpt-oss/, 'openai'],
  [/^kimi/, 'moonshot'],
  [/^glm/, 'zhipu'],
  [/^minimax/, 'minimax'],
  [/^nemotron/, 'nvidia'],
  [/^(command-r|aya)/, 'cohere']
]

function ollamaLineage(tag: string): ModelLineage {
  const name = tag.slice(tag.lastIndexOf('/') + 1).toLowerCase()
  return OLLAMA_LINEAGES.find(([pattern]) => pattern.test(name))?.[1] ?? 'unknown'
}

const LINEAGE_BY_AGENT: Partial<Record<TuiAgent, ModelLineage>> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
  gemini: 'google',
  antigravity: 'google',
  kimi: 'moonshot',
  'qwen-code': 'alibaba'
}

/** A family word only where no letter touches it: `sol` is never read out of "console". */
const family = (words: string) => new RegExp(`(?<![a-z])(?:${words})(?![a-z])`, 'i')

/**
 * The model names the family more exactly than the CLI that launched it: one agent can route to
 * several providers, so the model id is read first and the agent is the fallback. Estate aliases
 * (Argon, Astra, Luna, Sol, Terra, Fable) name their family too.
 */
const LINEAGE_BY_MODEL: readonly (readonly [RegExp, ModelLineage])[] = [
  [family('claude|anthropic|opus|sonnet|haiku|fable'), 'anthropic'],
  [family('gpt|chatgpt|openai|codex|astra|luna|sol|terra'), 'openai'],
  [/(?<![a-z0-9])o[1-9](?![a-z0-9])/i, 'openai'],
  [family('grok|xai'), 'xai'],
  [family('gemini|gemma|google|argon'), 'google'],
  [family('kimi|moonshot|moonshotai'), 'moonshot'],
  [family('qwen'), 'alibaba'],
  [family('deepseek'), 'deepseek'],
  [family('xiaomi|mimo'), 'xiaomi'],
  [family('minimax'), 'minimax'],
  [family('zhipu|glm'), 'zhipu']
]

/** `openrouter:vendor/model@effort` reads as the OpenRouter model `vendor/model`. */
function routedModel(
  agent: string | null | undefined,
  model: string | null | undefined
): { agent: string | null | undefined; model: string | undefined } {
  const bare = model?.trim().replace(/@[\w.-]+$/, '')
  return bare && bare.toLowerCase().startsWith('openrouter:')
    ? { agent: 'openrouter', model: bare.slice('openrouter:'.length) }
    : { agent, model: bare }
}

export function modelLineage(
  agentName: string | null | undefined,
  modelName?: string | null
): ModelLineage {
  const { agent, model } = routedModel(agentName, modelName)
  if (agent === 'openrouter') {
    return OPENROUTER_LINEAGES[model?.split('/')[0]?.toLowerCase() ?? ''] ?? 'unknown'
  }
  if (agent === 'ollama') {
    return ollamaLineage(model ?? '')
  }
  for (const [pattern, lineage] of LINEAGE_BY_MODEL) {
    if (model && pattern.test(model)) {
      return lineage
    }
  }
  return (agent && LINEAGE_BY_AGENT[agent as TuiAgent]) || 'unknown'
}

/** Two seats are independent only when both lineages are known and differ. */
export function isIndependentLineage(left: ModelLineage, right: ModelLineage): boolean {
  return left !== 'unknown' && right !== 'unknown' && left !== right
}

/**
 * Gemini never issues a review verdict or a judgement (Sal, 2026-08-09, after fabricated
 * blockers). It may still do work; it may not decide whether work passed. A seat whose family
 * this build cannot place is refused the same way: an unplaceable judge cannot be shown to be
 * independent of anything it judges.
 */
export function mayIssueVerdict(agent: string | null | undefined, model?: string | null): boolean {
  const lineage = modelLineage(agent, model)
  return lineage !== 'google' && lineage !== 'unknown'
}
