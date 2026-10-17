export type WorkflowOpenRouterModel = {
  id: string
  name: string
  contextLength: number
  promptPrice: number
  completionPrice: number
  tools: boolean
  structuredOutputs: boolean
}

/**
 * How cheap an OpenRouter model is, per 1M tokens in and out: `free` costs nothing, `very-low` is
 * at most $0.10 in and $0.50 out, `low` at most $0.50 in and $2 out.
 */
export type WorkflowOpenRouterPriceBand = 'free' | 'very-low' | 'low' | 'standard'
export const WORKFLOW_OPENROUTER_PRICE_BANDS = ['free', 'very-low', 'low', 'standard'] as const

export function workflowOpenRouterPriceBand(
  model: Pick<WorkflowOpenRouterModel, 'promptPrice' | 'completionPrice'>
): WorkflowOpenRouterPriceBand {
  const input = model.promptPrice * 1_000_000
  const output = model.completionPrice * 1_000_000
  if (input === 0 && output === 0) {
    return 'free'
  }
  if (input <= 0.1 && output <= 0.5) {
    return 'very-low'
  }
  return input <= 0.5 && output <= 2 ? 'low' : 'standard'
}

/** Whether a model is at most as expensive as the band: "low" also shows very low and free. */
export function workflowOpenRouterWithinBand(
  model: Pick<WorkflowOpenRouterModel, 'promptPrice' | 'completionPrice'>,
  band: WorkflowOpenRouterPriceBand
): boolean {
  return (
    WORKFLOW_OPENROUTER_PRICE_BANDS.indexOf(workflowOpenRouterPriceBand(model)) <=
    WORKFLOW_OPENROUTER_PRICE_BANDS.indexOf(band)
  )
}
