type ClaudeModelPricing = {
  input: number
  output: number
  cacheRead: number
  /** 5-minute TTL cache write (1.25x base input). */
  cacheWrite: number
  /** 1-hour TTL cache write (2x base input). */
  cacheWrite1h: number
  thresholdTokens?: number
  inputAboveThreshold?: number
  outputAboveThreshold?: number
  cacheReadAboveThreshold?: number
  cacheWriteAboveThreshold?: number
  cacheWrite1hAboveThreshold?: number
}

const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000
const SONNET_LONG_CONTEXT_PRICING = {
  thresholdTokens: LONG_CONTEXT_THRESHOLD_TOKENS,
  inputAboveThreshold: 6,
  outputAboveThreshold: 22.5,
  cacheReadAboveThreshold: 0.6,
  cacheWriteAboveThreshold: 7.5,
  cacheWrite1hAboveThreshold: 12
} satisfies Partial<ClaudeModelPricing>

const MODEL_PRICING: Record<string, ClaudeModelPricing> = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  // Why: Sonnet 5's rates except cache hits, which Sonnet 5.5 bills at 0.05x input.
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  // Why: Sonnet 5 bills its full 1M window at flat rates, so no long-context tier here.
  // Why: $2/$10 needs no date dimension — it launched as introductory pricing through
  // 2026-08-31 but is now the standard price; the 2026-09-01 rise to $3/$15 was cancelled.
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-4': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    ...SONNET_LONG_CONTEXT_PRICING
  },
  'claude-sonnet-3-7': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  'claude-sonnet-3-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  // Why: these are the rates for prompts up to 100k tokens. A longer prompt bills that whole
  // request at $0.50/$2.50/$0.05/$0.625, which a per-call or daily total cannot see, so those
  // requests are undercounted.
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    cacheWrite1h: 0.2
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 },
  'claude-haiku-3': {
    input: 0.25,
    output: 1.25,
    cacheRead: 0.03,
    cacheWrite: 0.3,
    cacheWrite1h: 0.5
  }
}

const MODEL_ALIASES: Record<string, string> = {
  model_placeholder_m26: 'claude-opus-4-6',
  model_placeholder_m35: 'claude-sonnet-4-6',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'claude-opus-4.8-thinking': 'claude-opus-4-8',
  'claude-opus-4.6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4.6-thinking': 'claude-sonnet-4-6',
  'claude-opus-4-8-thinking': 'claude-opus-4-8',
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6'
}

function hasClaudeModelVersion(model: string, family: string, version: string): boolean {
  const normalized = model.replace(/\./g, '-')
  return new RegExp(`${family}-${version}(?:$|[^0-9])`).test(normalized)
}

function isLegacyBaseOpus4Model(model: string): boolean {
  const normalized = model.replace(/\./g, '-')
  return /opus-4(?:$|-thinking$|-20\d{6}(?:-thinking)?$|@20\d{6}$)/.test(normalized)
}

function normalizeModelForPricing(model: string | null): string | null {
  if (!model) {
    return null
  }
  const lower = model
    .toLowerCase()
    .trim()
    .replace(/^anthropic[/:]/, '')
  const alias = MODEL_ALIASES[lower]
  if (alias) {
    return alias
  }
  if (hasClaudeModelVersion(lower, 'fable', '5')) {
    return 'claude-fable-5'
  }
  // Why: must precede the Opus 5 check, whose pattern also matches 'opus-5-5'.
  if (hasClaudeModelVersion(lower, 'opus', '5-5')) {
    return 'claude-opus-5-5'
  }
  if (hasClaudeModelVersion(lower, 'opus', '5')) {
    return 'claude-opus-5'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-8')) {
    return 'claude-opus-4-8'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-7')) {
    return 'claude-opus-4-7'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-6')) {
    return 'claude-opus-4-6'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-5')) {
    return 'claude-opus-4-5'
  }
  if (hasClaudeModelVersion(lower, 'opus', '4-1')) {
    return 'claude-opus-4-1'
  }
  if (isLegacyBaseOpus4Model(lower)) {
    return 'claude-opus-4'
  }
  if (lower.includes('opus-4')) {
    // Why: new Opus 4 point releases now share the current low Opus pricing;
    // avoid overbilling unknown future Claude Code model IDs as legacy Opus 4.
    return 'claude-opus-4-8'
  }
  // Why: must precede the Sonnet 5 check, whose pattern also matches 'sonnet-5-5'.
  if (hasClaudeModelVersion(lower, 'sonnet', '5-5')) {
    return 'claude-sonnet-5-5'
  }
  if (hasClaudeModelVersion(lower, 'sonnet', '5')) {
    return 'claude-sonnet-5'
  }
  if (hasClaudeModelVersion(lower, 'sonnet', '4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (hasClaudeModelVersion(lower, 'sonnet', '4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (lower.includes('sonnet-4')) {
    return 'claude-sonnet-4-6'
  }
  if (lower.includes('sonnet-3-7') || lower.includes('sonnet-3.7')) {
    return 'claude-sonnet-3-7'
  }
  // Why: legacy version-first IDs like `claude-3-5-sonnet-20241022` are still
  // present in historical Claude Code/SDK logs read off disk. Match them so
  // their cost is not silently dropped from the breakdown.
  if (
    lower.includes('sonnet-3-5') ||
    lower.includes('sonnet-3.5') ||
    lower.includes('3-5-sonnet') ||
    lower.includes('3.5-sonnet')
  ) {
    return 'claude-sonnet-3-5'
  }
  if (hasClaudeModelVersion(lower, 'haiku', '5-5')) {
    return 'claude-haiku-5-5'
  }
  if (lower.includes('haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  if (lower.includes('haiku-3-5') || lower.includes('haiku-3.5')) {
    return 'claude-haiku-3-5'
  }
  if (lower.includes('3-5-haiku') || lower.includes('3.5-haiku')) {
    return 'claude-haiku-3-5'
  }
  if (lower.includes('haiku-3')) {
    return 'claude-haiku-3'
  }
  return null
}

function calculateTieredCost(
  tokens: number,
  basePrice: number,
  abovePrice?: number,
  threshold?: number
): number {
  if (threshold === undefined || abovePrice === undefined) {
    return tokens * basePrice
  }
  const belowTokens = Math.min(tokens, threshold)
  const aboveTokens = Math.max(tokens - threshold, 0)
  return belowTokens * basePrice + aboveTokens * abovePrice
}

/**
 * @param cacheWriteTokens every cache write, both TTLs
 * @param cacheWrite1hTokens the 1-hour-TTL subset of `cacheWriteTokens`
 * @param longContextTiers false for a total spanning many requests, since the tier is per request
 */
export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  cacheWrite1hTokens = 0,
  { longContextTiers = true }: { longContextTiers?: boolean } = {}
): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  const thresholdTokens = longContextTiers ? pricing.thresholdTokens : undefined
  const write1hTokens = Math.min(Math.max(cacheWrite1hTokens, 0), cacheWriteTokens)
  // Why: both TTL buckets share one long-context allowance. Giving each its own
  // would make a split bucket cheaper than the same tokens billed entirely at 5m.
  const write1hShare = cacheWriteTokens > 0 ? write1hTokens / cacheWriteTokens : 0
  const write5mThreshold =
    thresholdTokens === undefined ? undefined : thresholdTokens * (1 - write1hShare)
  const write1hThreshold =
    thresholdTokens === undefined ? undefined : thresholdTokens * write1hShare
  return (
    (calculateTieredCost(inputTokens, pricing.input, pricing.inputAboveThreshold, thresholdTokens) +
      calculateTieredCost(
        outputTokens,
        pricing.output,
        pricing.outputAboveThreshold,
        thresholdTokens
      ) +
      calculateTieredCost(
        cacheReadTokens,
        pricing.cacheRead,
        pricing.cacheReadAboveThreshold,
        thresholdTokens
      ) +
      calculateTieredCost(
        cacheWriteTokens - write1hTokens,
        pricing.cacheWrite,
        pricing.cacheWriteAboveThreshold,
        write5mThreshold
      ) +
      calculateTieredCost(
        write1hTokens,
        pricing.cacheWrite1h,
        pricing.cacheWrite1hAboveThreshold,
        write1hThreshold
      )) /
    1_000_000
  )
}
