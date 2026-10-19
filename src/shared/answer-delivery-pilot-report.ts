/**
 * The hook-first answer pilot's measurement (PHASE1-SPEC §5): the app appends one line per
 * delivery state (`open`, then how it ended) to userData `answer-delivery-pilot.jsonl`, and
 * `omni answers pilot-report` summarises that file alone.
 */

export const ANSWER_DELIVERY_PILOT_FILE = 'answer-delivery-pilot.jsonl'

export type AnswerDeliveryPilotOutcome = 'open' | 'confirmed' | 'typed_fallback' | 'withdrawn'

export type AnswerDeliveryPilotRecord = {
  key: string
  id: string
  conversation: string
  path: string | null
  claimedAt: string
  injectedAt: string | null
  confirmedAt: string | null
  fallbackAt: string | null
  ackAt: string | null
  attempts: number
  outcome: AnswerDeliveryPilotOutcome
}

export type AnswerDeliveryPilotReport = {
  since: string
  deliveries: number
  byPath: Record<string, number>
  outcomes: Record<AnswerDeliveryPilotOutcome, number>
  /** Claim to confirmation, hook-confirmed deliveries only. */
  latencyMs: { p50: number | null; p95: number | null; samples: number }
  /** Typed fallbacks out of deliveries that ended confirmed or typed. */
  fallbackRate: number | null
  confirmedWithin5mRate: number | null
  medianAttempts: number | null
  /** Offered and not ended yet. */
  open: number
  invalidLines: number
}

const FIVE_MINUTES_MS = 5 * 60_000

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null
  }
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1]!
}

function isRecord(value: unknown): value is AnswerDeliveryPilotRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.claimedAt === 'string' &&
    typeof record.outcome === 'string' &&
    ['open', 'confirmed', 'typed_fallback', 'withdrawn'].includes(record.outcome)
  )
}

/** The latest line of each delivery claimed at or after `sinceMs`. */
export function summarizeAnswerDeliveryPilot(
  text: string,
  sinceMs: number
): AnswerDeliveryPilotReport {
  const latest = new Map<string, AnswerDeliveryPilotRecord>()
  let invalidLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      invalidLines++
      continue
    }
    if (!isRecord(parsed)) {
      invalidLines++
      continue
    }
    const claimed = Date.parse(parsed.claimedAt)
    if (Number.isFinite(claimed) && claimed >= sinceMs) {
      latest.set(`${parsed.id}@${parsed.claimedAt}`, parsed)
    }
  }
  const records = [...latest.values()]
  const outcomes: Record<AnswerDeliveryPilotOutcome, number> = {
    open: 0,
    confirmed: 0,
    typed_fallback: 0,
    withdrawn: 0
  }
  const byPath: Record<string, number> = {}
  const latencies: number[] = []
  const attempts: number[] = []
  for (const record of records) {
    outcomes[record.outcome]++
    if (record.path && record.outcome !== 'open') {
      byPath[record.path] = (byPath[record.path] ?? 0) + 1
    }
    if (record.outcome === 'confirmed' && record.confirmedAt) {
      const latency = Date.parse(record.confirmedAt) - Date.parse(record.claimedAt)
      if (Number.isFinite(latency)) {
        latencies.push(latency)
      }
    }
    if (record.outcome !== 'open' && typeof record.attempts === 'number') {
      attempts.push(record.attempts)
    }
  }
  latencies.sort((a, b) => a - b)
  attempts.sort((a, b) => a - b)
  const ended = outcomes.confirmed + outcomes.typed_fallback
  return {
    since: new Date(sinceMs).toISOString(),
    deliveries: records.length,
    byPath,
    outcomes,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      samples: latencies.length
    },
    fallbackRate: ended > 0 ? outcomes.typed_fallback / ended : null,
    confirmedWithin5mRate:
      ended > 0 ? latencies.filter((ms) => ms <= FIVE_MINUTES_MS).length / ended : null,
    medianAttempts: percentile(attempts, 0.5),
    open: outcomes.open,
    invalidLines
  }
}
