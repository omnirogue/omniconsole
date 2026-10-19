export type EvolveParetoCandidate = {
  id: string
  label: string
  costUsd?: number | null
  score?: number | null
}

export type EvolveParetoPoint = {
  candidate: EvolveParetoCandidate
  costUsd: number
  score: number
  onFrontier: boolean
  x: number
  y: number
}

export type EvolveParetoChartLabels = {
  title: string
  description: string
  cost: string
  score: string
  frontier: string
  dominated: string
  candidate: string
  status: string
  details: string
  empty: string
  summary: (count: number, frontierCount: number) => string
  omitted: (count: number) => string
  formatCost: (value: number) => string
  formatScore: (value: number) => string
}

export const DEFAULT_EVOLVE_PARETO_CHART_LABELS: EvolveParetoChartLabels = {
  title: 'Quality and cost',
  description:
    'Higher scores and lower costs are better. Frontier candidates have no alternative with an equal or higher score at an equal or lower cost and a strict improvement in at least one.',
  cost: 'Cost (USD)',
  score: 'Score',
  frontier: 'Pareto frontier',
  dominated: 'Dominated',
  candidate: 'Candidate',
  status: 'Status',
  details: 'Candidate details',
  empty: 'No candidates with measured scores and costs yet.',
  summary: (count, frontierCount) => `${frontierCount} of ${count} candidates on the frontier`,
  omitted: (count) =>
    `${count} candidates omitted because measurements or identifiers are invalid.`,
  formatCost: (value) =>
    value.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      maximumSignificantDigits: 3
    }),
  formatScore: (value) => value.toLocaleString(undefined, { maximumSignificantDigits: 3 })
}

export const EVOLVE_PARETO_PLOT = {
  width: 640,
  height: 320,
  left: 80,
  right: 616,
  top: 24,
  bottom: 256
} as const

type Tick = { value: number; position: number }
export type EvolveParetoChart = {
  points: EvolveParetoPoint[]
  frontier: EvolveParetoPoint[]
  omittedCount: number
  costTicks: Tick[]
  scoreTicks: Tick[]
}

function measured(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Scale before subtraction so finite scores spanning both numeric extremes stay finite.
function fraction(value: number, low: number, high: number): number {
  const scale = Math.max(Math.abs(low), Math.abs(high), Number.MIN_VALUE)
  return (value / scale - low / scale) / (high / scale - low / scale)
}

function ticks(low: number, high: number, start: number, end: number): Tick[] {
  return [0, 0.25, 0.5, 0.75, 1].map((part) => ({
    value: low * (1 - part) + high * part,
    position: start + (end - start) * part
  }))
}

/** Minimize cost, maximize score; identical measurements are co-frontier, not dominators. */
export function buildEvolveParetoChart(
  candidates: readonly EvolveParetoCandidate[]
): EvolveParetoChart {
  const seen = new Set<string>()
  const points: EvolveParetoPoint[] = []
  let maxCost = 0
  let minScore = 0
  let maxScore = 0
  for (const candidate of candidates) {
    const { id, costUsd, score } = candidate
    if (!id.trim() || seen.has(id) || !measured(costUsd) || costUsd < 0 || !measured(score)) {
      continue
    }
    seen.add(id)
    maxCost = Math.max(maxCost, costUsd)
    minScore = Math.min(minScore, score)
    maxScore = Math.max(maxScore, score)
    points.push({ candidate, costUsd, score, onFrontier: false, x: 0, y: 0 })
  }

  const ordered = [...points].sort((a, b) => a.costUsd - b.costUsd || b.score - a.score)
  const frontier: EvolveParetoPoint[] = []
  let bestScore = -Infinity
  let bestCost = -Infinity
  for (const point of ordered) {
    if (point.score > bestScore || (point.score === bestScore && point.costUsd === bestCost)) {
      point.onFrontier = true
      frontier.push(point)
      bestScore = point.score
      bestCost = point.costUsd
    }
  }

  const costHigh = maxCost || 1
  const scoreHigh = minScore === maxScore ? 1 : maxScore
  const { left, right, top, bottom } = EVOLVE_PARETO_PLOT
  for (const point of points) {
    point.x = left + fraction(point.costUsd, 0, costHigh) * (right - left)
    point.y = bottom - fraction(point.score, minScore, scoreHigh) * (bottom - top)
  }
  return {
    points,
    frontier,
    omittedCount: candidates.length - points.length,
    costTicks: ticks(0, costHigh, left, right),
    scoreTicks: ticks(minScore, scoreHigh, bottom, top)
  }
}

export function describeEvolveParetoPoint(
  point: EvolveParetoPoint,
  labels: EvolveParetoChartLabels
): string {
  return [
    point.candidate.label || point.candidate.id,
    `${labels.cost}: ${labels.formatCost(point.costUsd)}`,
    `${labels.score}: ${labels.formatScore(point.score)}`,
    point.onFrontier ? labels.frontier : labels.dominated
  ].join(' · ')
}
