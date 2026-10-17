import { recipeMean } from './decision-recipe-outcomes.mjs'

export function wilsonInterval(positives, total) {
  if (!total) {
    return null
  }
  const z2 = 1.96 ** 2
  const p = positives / total
  const denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total)
  const radius = 1.96 * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)
  return {
    lower: Math.max(0, (centre - radius) / denominator),
    upper: Math.min(1, (centre + radius) / denominator)
  }
}

export function reliabilityBands(pairs) {
  const bands = [
    { label: '[0,0.1)', contains: (p) => p < 0.1 },
    { label: '[0.1,0.2)', contains: (p) => p >= 0.1 && p < 0.2 },
    { label: '[0.2,0.8]', contains: (p) => p >= 0.2 && p <= 0.8 },
    { label: '(0.8,0.9]', contains: (p) => p > 0.8 && p <= 0.9 },
    { label: '(0.9,1]', contains: (p) => p > 0.9 }
  ]
  return bands.map(({ label, contains }) => {
    const rows = pairs.filter(([p]) => contains(p))
    const positives = rows.reduce((sum, [, value]) => sum + value, 0)
    return {
      band: label,
      count: rows.length,
      meanPrediction: recipeMean(rows.map(([p]) => p)),
      observedLabelRate: recipeMean(rows.map(([, y]) => y)),
      labelRateWilson95: wilsonInterval(positives, rows.length)
    }
  })
}

export function rankedProbabilityScore(answer, label) {
  const probabilities = Object.values(answer.probabilities)
  let cumulative = 0
  let total = 0
  for (let i = 0; i < probabilities.length - 1; i++) {
    cumulative += probabilities[i]
    total += (cumulative - Number(label <= i)) ** 2
  }
  return total / (probabilities.length - 1)
}
