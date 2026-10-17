import type { WorkflowRoute } from './workflow-graph'
import {
  claudeLongContextModel,
  workflowModelContextTokens,
  WORKFLOW_LONG_CONTEXT_OPUS
} from './workflow-model-context-window'

/**
 * Quick Discover sends the whole scope in one prompt, so it runs only when that prompt leaves room
 * to think and answer: at most this share of the seat's context window. Past it, the run is
 * refused, never cut or chunked (chunked reading measured worse than full Discover).
 */
export const QUICK_DISCOVER_CONTEXT_SHARE = 0.6

/** Deliberately low for numbered source, so the estimate errs towards refusing. */
export const QUICK_DISCOVER_CHARS_PER_TOKEN = 3

export function quickDiscoverTokenEstimate(chars: number): number {
  return Math.ceil(chars / QUICK_DISCOVER_CHARS_PER_TOKEN)
}

export type QuickDiscoverBudget = { contextTokens: number; budgetTokens: number; model: string }

export function quickDiscoverBudget(route: WorkflowRoute, model: string): QuickDiscoverBudget {
  const contextTokens = workflowModelContextTokens(route, model)
  return {
    contextTokens,
    budgetTokens: Math.floor(contextTokens * QUICK_DISCOVER_CONTEXT_SHARE),
    model
  }
}

function fitsLongContextOpus(estimatedTokens: number, model: string): boolean {
  const budget = quickDiscoverBudget('claude', WORKFLOW_LONG_CONTEXT_OPUS).budgetTokens
  return /^claude-/i.test(model) && !claudeLongContextModel(model) && estimatedTokens <= budget
}

/** Why Quick Discover cannot run on a scope this large, and what to run instead. */
export function quickDiscoverOverBudgetMessage(
  estimatedTokens: number,
  budget: QuickDiscoverBudget
): string {
  const tokens = (value: number) => value.toLocaleString('en-US')
  const longContext = fitsLongContextOpus(estimatedTokens, budget.model)
    ? ` Or read it with the 1M-context Opus seat: choose ${WORKFLOW_LONG_CONTEXT_OPUS} for the reader, or pass --spec-file with {"steps":{"find":{"agents":[{"route":"claude","model":"${WORKFLOW_LONG_CONTEXT_OPUS}"}]}}}.`
    : ''
  return (
    `Quick Discover reads the whole scope in one call, and this scope is about ${tokens(estimatedTokens)} tokens: ` +
    `over its budget of ${tokens(budget.budgetTokens)} (${Math.round(QUICK_DISCOVER_CONTEXT_SHARE * 100)}% of ${budget.model}'s ${tokens(budget.contextTokens)}-token context). ` +
    `Run Discover instead (--template discover), or choose a smaller folder.${longContext}`
  )
}
