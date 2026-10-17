import type { EvolveRunRecord } from './evolve-workflow'

export type EvolveWinnerMetrics = {
  winnerCandidateId: string
  winnerDigest: string
  baselineScore: number | null
  challengerScore: number | null
  heldOutDelta: number | null
  blindAuditScore: string
  /** null: the ledger recorded no gate result, which is never read as a pass. */
  blindAuditPassed: boolean | null
  creditsSpent: number | null
  spendUsd: number | null
  summaryLine: string
}

function fmtScore(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '—'
}

function gateResult(value: boolean | null | undefined): string {
  return value === true ? 'pass' : value === false ? 'fail' : 'not recorded'
}

/** The settled run's winner and its promotion evidence, as the ledger recorded it. */
export function evolveWinnerMetrics(record: EvolveRunRecord): EvolveWinnerMetrics | null {
  if (record.state !== 'done') {
    return null
  }
  const ledger = record.ledger
  const promo = ledger?.promotions?.[0]
  const winnerCandidateId =
    ledger?.best_so_far?.candidate_id ??
    ledger?.summary?.best_candidate_id ??
    promo?.candidate_id ??
    null
  if (!winnerCandidateId) {
    return null
  }
  const winnerDigest =
    ledger?.best_so_far?.program_sha ??
    record.submitted?.specSha ??
    ledger?.spec_sha ??
    winnerCandidateId
  const seed = ledger?.seeded?.[0]
  const baselineScore = seed?.prior_combined_score ?? seed?.combined_score ?? null
  const challengerScore =
    ledger?.best_so_far?.combined_score ?? ledger?.summary?.best_combined_score ?? null
  const heldOutDelta =
    typeof challengerScore === 'number' && typeof baselineScore === 'number'
      ? Number((challengerScore - baselineScore).toFixed(4))
      : null
  const hardPass = promo?.hard_pass
  const intervalsPass = promo?.intervals_pass
  const blindAuditPassed =
    hardPass === false || intervalsPass === false
      ? false
      : hardPass === true && intervalsPass === true
        ? true
        : null
  const evaluated =
    ledger?.summary?.evaluated_mutations ?? ledger?.iterations?.evaluated_mutations ?? 0
  const blindAuditScore = promo
    ? `${promo.decision} · hard ${gateResult(hardPass)} · intervals ${gateResult(intervalsPass)}`
    : `No promotion evidence (${evaluated} mutations evaluated)`
  const spendUsd = ledger?.budget?.spend_usd ?? null
  const creditsSpent = typeof spendUsd === 'number' ? Math.max(1, Math.round(spendUsd * 100)) : null
  const deltaText =
    heldOutDelta !== null ? `${heldOutDelta >= 0 ? '+' : ''}${heldOutDelta.toFixed(3)}` : 'n/a'
  const summaryLine = `Candidate ${winnerCandidateId} settled on ${record.request.target} with score ${fmtScore(challengerScore)} (held-out delta ${deltaText}, audit: ${blindAuditScore}).`
  return {
    winnerCandidateId,
    winnerDigest,
    baselineScore,
    challengerScore,
    heldOutDelta,
    blindAuditScore,
    blindAuditPassed,
    creditsSpent,
    spendUsd,
    summaryLine
  }
}

/** Promotion is recommended only on a recorded pass of both gates. */
export function evolvePromotionRecommended(
  metrics: Pick<EvolveWinnerMetrics, 'blindAuditPassed'>
): boolean {
  return metrics.blindAuditPassed === true
}
