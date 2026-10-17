/**
 * What the person decided on a Discover run's OmniOS page, one row per finding, as the page's
 * scripts record it in the run's folder (decide.sh). Later runs read it: a finding picked Start or
 * Dig deeper is listed to their finders as already reported, and `omni workflow stats` counts how
 * often a page's findings are acted on.
 */

export const DISCOVER_DECISIONS_FILE = 'decisions.json'

export const DISCOVER_DECISION_PICKS = ['start', 'dig', 'not-now'] as const
export type DiscoverDecisionPick = (typeof DISCOVER_DECISION_PICKS)[number]

export type DiscoverDecision = {
  /** The finding's number on the page. */
  n: number
  /** The run's target key for the finding (findings.json `key`). */
  key: string
  title: string
  pick: DiscoverDecisionPick
  at: string
  /** Start: the session launch; Dig deeper: the run it started. Absent until one exists. */
  receipt?: { operationId?: string; terminal?: string; executionId?: string }
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** The decisions a file holds; a malformed row is left out rather than failing the file. */
export function parseDiscoverDecisions(value: unknown): DiscoverDecision[] {
  const rows = (value as { decisions?: unknown } | null)?.decisions
  if (!Array.isArray(rows)) {
    return []
  }
  return rows.flatMap((row): DiscoverDecision[] => {
    const entry = row as Partial<DiscoverDecision> | null
    if (
      !entry ||
      !Number.isInteger(entry.n) ||
      typeof entry.key !== 'string' ||
      !DISCOVER_DECISION_PICKS.includes(entry.pick as DiscoverDecisionPick)
    ) {
      return []
    }
    const receipt = entry.receipt
    const kept = receipt
      ? {
          ...(text(receipt.operationId) ? { operationId: receipt.operationId } : {}),
          ...(text(receipt.terminal) ? { terminal: receipt.terminal } : {}),
          ...(text(receipt.executionId) ? { executionId: receipt.executionId } : {})
        }
      : {}
    return [
      {
        n: entry.n!,
        key: entry.key,
        title: typeof entry.title === 'string' ? entry.title : '',
        pick: entry.pick!,
        at: typeof entry.at === 'string' ? entry.at : '',
        ...(Object.keys(kept).length ? { receipt: kept } : {})
      }
    ]
  })
}

/** Every recorded pick on one computer's Discover pages: how often a finding is acted on. */
export type DiscoverDecisionTotals = {
  /** Runs whose page recorded at least one pick. */
  runs: number
  picks: { start: number; dig: number; notNow: number }
  /** Start picks with a launch receipt and Dig deeper picks with a run receipt. */
  launched: number
  /** Start or Dig deeper, of every recorded pick; unknown when none was recorded. */
  actedOnRate: number | 'unknown'
}

/** Target keys the person picked Start or Dig deeper on. */
export function discoverActedOnKeys(decisions: readonly DiscoverDecision[]): Set<string> {
  return new Set(
    decisions
      .filter((decision) => decision.pick !== 'not-now' && decision.key)
      .map((decision) => decision.key)
  )
}
