import type { WorkflowProgramContext } from '../workflow-program-context'
import { discoverV7RankCall, type DiscoverV7Verified } from './discover-v7-calls'
import {
  discoverV7Plural,
  type DiscoverV7Area,
  type DiscoverV7Ledger,
  type DiscoverV7Plan,
  type DiscoverV7Record,
  type DiscoverV7Status,
  type DiscoverV7Vote
} from './discover-v7-plan'
import {
  discoverV7EmptySummary,
  discoverV7RankedSummary,
  type DiscoverV7Report
} from './discover-v7-report'

type Task = { prompt: string; evidence: string }
export type DiscoverV7Settled = {
  record: DiscoverV7Record
  votes: (DiscoverV7Vote | null)[]
  status: DiscoverV7Status
}

/**
 * Settles the outcome of every report and ranks what was confirmed. A repeat was never verified:
 * it shares its original's outcome and reaches Rank only as that original's provenance, so Rank
 * sees each defect once with one verdict. Every verified report keeps its own verdict; the refuted
 * and unverified lists come from those verdicts, never from the ranker.
 */
export async function finishDiscoverV7(
  context: WorkflowProgramContext,
  plan: DiscoverV7Plan,
  task: Task,
  run: {
    areas: readonly DiscoverV7Area[]
    ledger: DiscoverV7Ledger
    verdicts: ReadonlyMap<string, DiscoverV7Settled>
  }
) {
  const { ledger, verdicts } = run
  const status = (record: DiscoverV7Record): DiscoverV7Status =>
    verdicts.get(record.duplicateOf ?? record.id)?.status ?? 'unverified'
  const distinct = ledger.records.filter((record) => !record.duplicateOf)
  const confirmed = distinct.filter((record) => status(record) === 'confirmed')
  const refuted = distinct.filter((record) => status(record) === 'refuted')
  const unverified = distinct.filter((record) => status(record) === 'unverified')
  const findings = ledger.records.map((record) => ({
    id: record.id,
    title: record.finding.title,
    status: status(record),
    ...(record.duplicateOf ? { duplicateOf: record.duplicateOf } : {})
  }))
  // Counts what was verified, never how many defects exist: a repeat no check caught still counts.
  const repeats = ledger.records.length - distinct.length
  const verifiedLine = repeats
    ? `${distinct.length} of ${ledger.records.length} reported findings (${discoverV7Plural(repeats, 'repeat', 'repeats')} set aside)`
    : discoverV7Plural(distinct.length, 'finding', 'findings')
  context.log(
    `Verified ${verifiedLine}: ${confirmed.length} confirmed, ${refuted.length} refuted, ${unverified.length} unverified.`
  )
  const areas = [...run.areas]
  const lists = {
    refutedIds: refuted.map((record) => record.id),
    unverifiedIds: unverified.map((record) => record.id)
  }
  if (!confirmed.length) {
    const report: DiscoverV7Report = {
      summary: discoverV7EmptySummary({
        found: ledger.records.length,
        duplicates: ledger.records.length - distinct.length,
        refuted: refuted.length,
        unverified: unverified.length,
        searched: ledger.searched,
        failed: ledger.failed
      }),
      items: [],
      ...lists
    }
    return { areas, findings, dropped: ledger.dropped, report }
  }
  context.phase('Rank')
  const verified: DiscoverV7Verified[] = confirmed.map((record) => ({
    ...verdicts.get(record.id)!,
    duplicates: ledger.records.filter((entry) => entry.duplicateOf === record.id)
  }))
  // The final step is not made lasting: when it fails the run fails, and Retry re-runs only it.
  const ranked = (await context.agent(
    discoverV7RankCall(plan, task, { confirmed: verified, refuted, unverified })
  )) as DiscoverV7Report
  // The lists and counts follow the verdicts; the ranker only orders and groups what was confirmed.
  const summary = discoverV7RankedSummary(ranked, {
    confirmed: confirmed.length,
    refuted: refuted.length,
    unverified: unverified.length
  })
  const report: DiscoverV7Report = { ...ranked, summary, ...lists }
  return { areas, findings, dropped: ledger.dropped, report }
}
