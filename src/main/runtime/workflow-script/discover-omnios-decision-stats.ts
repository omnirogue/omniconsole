import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscoverDecisionTotals } from '../../../shared/discover-omnios-decisions'
import { readDiscoverDecisions } from './discover-omnios-decisions-read'

/** The template a delivered page was made for, from its findings.json. */
function pageTemplate(root: string, executionId: string): string | undefined {
  try {
    const run = JSON.parse(readFileSync(join(root, executionId, 'findings.json'), 'utf8')) as {
      template?: unknown
    }
    return typeof run.template === 'string' ? run.template : undefined
  } catch {
    return undefined
  }
}

/** Every recorded pick on this computer's Discover pages, under the stats filters. */
export function discoverDecisionStats(
  root: string,
  request: { template?: string; since?: number }
): DiscoverDecisionTotals {
  let runs: string[] = []
  try {
    runs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No page was ever delivered here.
  }
  const totals: DiscoverDecisionTotals = {
    runs: 0,
    picks: { start: 0, dig: 0, notNow: 0 },
    launched: 0,
    actedOnRate: 'unknown'
  }
  for (const executionId of runs.sort()) {
    const decisions = readDiscoverDecisions(root, executionId).filter(
      (decision) => request.since === undefined || Date.parse(decision.at) >= request.since
    )
    if (
      !decisions.length ||
      (request.template && pageTemplate(root, executionId) !== request.template)
    ) {
      continue
    }
    totals.runs++
    for (const decision of decisions) {
      if (decision.pick === 'not-now') {
        totals.picks.notNow++
        continue
      }
      totals.picks[decision.pick]++
      const receipt = decision.receipt
      if (
        decision.pick === 'start' ? receipt?.operationId && receipt.terminal : receipt?.executionId
      ) {
        totals.launched++
      }
    }
  }
  const { start, dig, notNow } = totals.picks
  const picked = start + dig + notNow
  return picked ? { ...totals, actedOnRate: (start + dig) / picked } : totals
}
