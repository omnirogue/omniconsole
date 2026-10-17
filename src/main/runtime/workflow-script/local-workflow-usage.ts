import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowCallCost } from '../../../shared/local-workflow-view'
import { estimateCostUsd as estimateClaudeCostUsd } from '../../claude-usage/claude-model-pricing'
import { estimateCostUsd as estimateCodexCostUsd } from '../../codex-usage/codex-usage-cost-estimate'

export type LocalWorkflowTokens = { input: number; output: number }

const FLAT_RATES = { longContextTiers: false }

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function field(source: Record<string, unknown>, key: string): boolean {
  return typeof source[key] === 'number' && Number.isFinite(source[key])
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Normalises the provider usage stored on an accepted receipt. Claude and Grok report cached
 * input separately, so it is added back; Codex input already includes its cached share; Gemini
 * reports through `stats`. Unknown or empty shapes report nothing rather than zero.
 */
export function localWorkflowReceiptTokens(
  route: LocalWorkflowRoute,
  usage: unknown
): LocalWorkflowTokens | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined
  }
  const raw = usage as Record<string, unknown>
  const source =
    route === 'gemini' && raw.stats && typeof raw.stats === 'object'
      ? (raw.stats as Record<string, unknown>)
      : raw
  if (!field(source, 'input_tokens') && !field(source, 'output_tokens')) {
    return undefined
  }
  const cached =
    route === 'claude' || route === 'grok'
      ? count(source.cache_creation_input_tokens) + count(source.cache_read_input_tokens)
      : 0
  return {
    input: count(source.input_tokens) + cached,
    output: count(source.output_tokens)
  }
}

export function sumLocalWorkflowTokens(
  entries: readonly (LocalWorkflowTokens | undefined)[]
): LocalWorkflowTokens | undefined {
  let total: LocalWorkflowTokens | undefined
  for (const entry of entries) {
    if (entry) {
      total = {
        input: (total?.input ?? 0) + entry.input,
        output: (total?.output ?? 0) + entry.output
      }
    }
  }
  return total
}

/** The provider's own bill on its last result line (Claude's `total_cost_usd`), read from the end. */
export function localWorkflowReportedCostUsd(stdout: string): number | undefined {
  for (let end = stdout.length; end > 0;) {
    const start = stdout.lastIndexOf('\n', end - 1) + 1
    const line = stdout.slice(start, end)
    end = start - 1
    if (!line.includes('total_cost_usd')) {
      continue
    }
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = record(JSON.parse(line))
    } catch {
      continue
    }
    if (parsed?.type === 'result') {
      const cost = parsed.total_cost_usd
      return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined
    }
  }
  return undefined
}

/**
 * List prices times an accepted receipt's tokens. Claude reports which cache writes used the
 * 1-hour TTL, billed at 2x input rather than 1.25x; Codex input already includes its cached share.
 * Long-context tiers bill per request and a receipt sums every request in the call, so they are
 * left out: a long request is undercounted rather than a run of short ones overcounted.
 */
export function localWorkflowTableCostUsd(
  route: LocalWorkflowRoute,
  model: string,
  usage: unknown
): number | undefined {
  const raw = record(usage)
  if (!raw || (!field(raw, 'input_tokens') && !field(raw, 'output_tokens'))) {
    return undefined
  }
  const cost =
    route === 'claude'
      ? estimateClaudeCostUsd(
          model,
          count(raw.input_tokens),
          count(raw.output_tokens),
          count(raw.cache_read_input_tokens),
          count(raw.cache_creation_input_tokens),
          count(record(raw.cache_creation)?.ephemeral_1h_input_tokens),
          FLAT_RATES
        )
      : route === 'codex'
        ? estimateCodexCostUsd(
            model,
            count(raw.input_tokens),
            count(raw.cached_input_tokens),
            count(raw.output_tokens),
            FLAT_RATES
          )
        : null
  return cost ?? undefined
}

/**
 * An accepted attempt's cost: the provider's own bill, else list prices for the one model that
 * answered. Token totals across several models cannot be priced, so that attempt stays unpriced.
 */
export function localWorkflowCallCost(
  seat: { agent: LocalWorkflowRoute; model: string },
  receipt: { usage?: unknown; resolvedModels?: unknown } | undefined,
  reportedUsd: number | undefined
): LocalWorkflowCallCost | undefined {
  if (reportedUsd !== undefined) {
    return { usd: reportedUsd, source: 'cli' }
  }
  const resolved = Array.isArray(receipt?.resolvedModels)
    ? receipt.resolvedModels.filter((model): model is string => typeof model === 'string')
    : []
  const model = resolved.length > 1 ? undefined : (resolved[0] ?? seat.model)
  const usd = model ? localWorkflowTableCostUsd(seat.agent, model, receipt?.usage) : undefined
  return usd === undefined ? undefined : { usd, source: 'table' }
}
