import type { CodexModelPricing, TieredPrice } from './codex-model-pricing'
import { MODEL_PRICING, normalizeModelForPricing } from './codex-model-pricing'

function calculateTieredCost(tokens: number, basePrice: number, tiers: TieredPrice[] = []): number {
  let cost = 0
  let lowerBound = 0
  let activePrice = basePrice
  for (const tier of tiers) {
    if (tokens <= tier.threshold) {
      return cost + Math.max(tokens - lowerBound, 0) * activePrice
    }
    cost += (tier.threshold - lowerBound) * activePrice
    lowerBound = tier.threshold
    activePrice = tier.price
  }
  return cost + Math.max(tokens - lowerBound, 0) * activePrice
}

export function estimateCostUsd(
  model: string | null,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  { longContextTiers = true }: { longContextTiers?: boolean } = {}
): number | null {
  const normalized = normalizeModelForPricing(model)
  if (!normalized) {
    return null
  }
  const pricing = MODEL_PRICING[normalized]
  // Why: the tier is billed per request, so a total spanning many requests must opt out.
  const tiers: Partial<CodexModelPricing> = longContextTiers ? pricing : {}
  const clampedCached = Math.min(cachedInputTokens, inputTokens)
  // Why: Codex cached tokens are part of the input bucket. Charge uncached
  // input on (input-cached) so cached tokens are not billed once at full input
  // price and again at cache-read price.
  const nonCachedInputTokens = Math.max(inputTokens - clampedCached, 0)
  return (
    (calculateTieredCost(nonCachedInputTokens, pricing.input, tiers.inputTiers) +
      calculateTieredCost(clampedCached, pricing.cachedInput, tiers.cachedInputTiers) +
      calculateTieredCost(outputTokens, pricing.output, tiers.outputTiers)) /
    1_000_000
  )
}
