/**
 * Session parity (step 8) in CLI text: a row's bucket, a host's buckets and a paired owner's ledger
 * state (G2), worded the same in `session list`, `session sidebar-counts`, `session hosts` and
 * `session ledger`. Every field is optional here: an older window or controller sends none.
 */

import type {
  SessionOwnerLedgerState,
  SessionParityBucketCounts,
  SessionParityFields,
  SessionParityPopulation
} from '../shared/session-parity'

/** `bucket ownerListed`, `bucket receiverOnly (unverified: not-in-owner-ledger)`, …; null if absent. */
export function formatParityBucket(row: Partial<SessionParityFields>): string | null {
  if (!row.bucket) {
    return null
  }
  const doubt =
    row.verification && row.verification !== 'verified'
      ? ` (${row.verification}${row.bucketReason ? `: ${row.bucketReason}` : ''})`
      : ''
  const rest = row.rest && row.rest !== 'live' ? `, ${row.rest} on its owner` : ''
  return `bucket ${row.bucket}${doubt}${rest}`
}

/** "25 owner-listed, 1 held by owner, 2 only here (2 can't verify), 1 workflow · 3 archived". */
export function formatParityBuckets(
  counts: Partial<SessionParityBucketCounts & { background: number }>
): string | null {
  if (counts.ownerListed === undefined) {
    return null
  }
  const parts = [
    `${counts.ownerListed} owner-listed`,
    counts.heldByOwner ? `${counts.heldByOwner} held by owner` : null,
    counts.receiverOnly ? `${counts.receiverOnly} only here` : null,
    counts.workflow ? `${counts.workflow} workflow` : null,
    counts.background ? `${counts.background} background` : null
  ].filter((part): part is string => part !== null)
  const within = [
    counts.unverified ? `${counts.unverified} can't verify` : null,
    counts.stale ? `${counts.stale} as of last list` : null,
    counts.archived ? `${counts.archived} archived` : null
  ].filter((part): part is string => part !== null)
  return `${parts.join(', ')}${within.length ? ` (${within.join(', ')})` : ''}`
}

/** G2 in words: ready, "as of <time>", older OmniConsole, or out of reach. */
export function formatOwnerLedgerState(ledger: SessionOwnerLedgerState): string {
  const at = ledger.asOf ? new Date(ledger.asOf).toISOString() : null
  switch (ledger.state) {
    case 'ready':
      return `ledger ready (revision ${ledger.revision ?? '?'}${ledger.source ? `, ${ledger.source}-authored` : ''})`
    case 'stale':
      return `ledger as of ${at ?? 'an earlier run'} (restored, not confirmed live)`
    case 'older':
      return 'older OmniConsole: paused and archived conversations not listed'
    case 'unreachable':
      return `ledger unreachable${at ? `, last listed ${at}` : ''}`
  }
}

/** One line per host of the unfiltered population, then each paired owner's ledger state. */
export function formatParityPopulation(population: SessionParityPopulation): string[] {
  return [
    `Parity population (every sidebar row, before filters): ${population.rows.length} rows`,
    ...population.countsByHost.map(
      (host) => `  ${host.hostId}: ${host.count} — ${formatParityBuckets(host)}`
    ),
    ...population.ownerLedgers.map(
      (ledger) => `  ${ledger.hostId}: ${formatOwnerLedgerState(ledger)}`
    )
  ]
}
