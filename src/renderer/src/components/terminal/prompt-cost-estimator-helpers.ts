export type PromptCostEstimate = {
  inputTokens: number
  inputCostUsd: number | null
}

export type PromptCostEstimatorLabels = {
  estimatedCost: (cost: string) => string
  estimatedTokens: (tokens: string) => string
  model: (name: string) => string
  unavailable: string
  description: string
  pricingUnavailable: string
}

export const DEFAULT_PROMPT_COST_ESTIMATOR_LABELS: PromptCostEstimatorLabels = {
  estimatedCost: (cost) => `Est. input ${cost}`,
  estimatedTokens: (tokens) => `About ${tokens} input tokens`,
  model: (name) => `Model: ${name}`,
  unavailable: 'Input cost unavailable',
  description:
    'Approximate text input cost in USD. Excludes conversation history, system instructions, attachments, output, tools, and cache discounts. Actual usage may differ.',
  pricingUnavailable: 'Input pricing is unavailable for this model. Token count is approximate.'
}

const usdFormatOptions: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
}

export function estimatePromptTokens(prompt: string): number {
  if (!prompt.trim()) {
    return 0
  }
  // UTF-8 bytes / 4 is a rough heuristic, not a model-specific tokenizer.
  return Math.ceil(new TextEncoder().encode(prompt).length / 4)
}

export function estimatePromptCost(
  prompt: string,
  inputUsdPerMillion?: number | null
): PromptCostEstimate {
  const inputTokens = estimatePromptTokens(prompt)
  if (
    inputUsdPerMillion == null ||
    !Number.isFinite(inputUsdPerMillion) ||
    inputUsdPerMillion < 0
  ) {
    return { inputTokens, inputCostUsd: null }
  }

  const inputCostUsd = inputTokens * (inputUsdPerMillion / 1_000_000)
  return {
    inputTokens,
    inputCostUsd: Number.isFinite(inputCostUsd) ? inputCostUsd : null
  }
}

export function formatPromptCostUsd(costUsd: number, locale = 'en-US'): string {
  const formatter = new Intl.NumberFormat(locale, usdFormatOptions)
  if (costUsd > 0 && costUsd < 0.0001) {
    return `<${formatter.format(0.0001)}`
  }
  return formatter.format(costUsd)
}

export function promptCostEstimatorText(
  estimate: PromptCostEstimate,
  labels: Partial<PromptCostEstimatorLabels> = {},
  locale = 'en-US',
  modelLabel?: string
): {
  summary: string
  tokens: string
  description: string
  model: string | null
  accessible: string
} {
  const copy = { ...DEFAULT_PROMPT_COST_ESTIMATOR_LABELS, ...labels }
  const summary =
    estimate.inputCostUsd === null
      ? copy.unavailable
      : copy.estimatedCost(formatPromptCostUsd(estimate.inputCostUsd, locale))
  const tokens = copy.estimatedTokens(new Intl.NumberFormat(locale).format(estimate.inputTokens))
  const model = modelLabel?.trim() ? copy.model(modelLabel) : null
  return {
    summary,
    tokens,
    description: estimate.inputCostUsd === null ? copy.pricingUnavailable : copy.description,
    model,
    accessible: [summary, tokens, model].filter(Boolean).join('. ')
  }
}
