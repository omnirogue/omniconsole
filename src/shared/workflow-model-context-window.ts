import type { LocalWorkflowRoute } from './local-workflow-seats'

/** Where a window is not known for certain, the smallest current frontier window. */
const DEFAULT_CONTEXT_TOKENS = 200_000
const LONG_CONTEXT_TOKENS = 1_000_000

/** The Claude workflow seat that reads with the 1M window (`WORKFLOW_ROUTE_MODELS`). */
export const WORKFLOW_LONG_CONTEXT_OPUS = 'claude-opus-5-5[1m]'

/**
 * Whether a Claude model id asks for the 1M window (`claude-opus-5-5[1m]`). The CLI's reported
 * contextWindow is 1M for plain ids too, so only this suffix tells the variants apart.
 */
export function claudeLongContextModel(model: string): boolean {
  return /\[1m\]$/i.test(model.trim())
}

/**
 * The context window a workflow seat's model runs with: Claude's CLI models run at 200k unless
 * the id asks for the 1M window; Gemini's run at 1M.
 */
export function workflowModelContextTokens(route: LocalWorkflowRoute, model: string): number {
  if (route === 'claude') {
    return claudeLongContextModel(model) ? LONG_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS
  }
  return route === 'gemini' ? LONG_CONTEXT_TOKENS : DEFAULT_CONTEXT_TOKENS
}
