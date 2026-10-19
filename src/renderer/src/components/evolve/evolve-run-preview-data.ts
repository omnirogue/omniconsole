import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import { JUDGE_FAMILIES, type EvolveJudgment } from './evolve-judge-audit-helpers'
import type { EvolveParetoCandidate } from './evolve-pareto-chart-helpers'

const VERDICTS = new Set(['candidate', 'baseline', 'tie'])
const FAMILIES = new Set<string>(JUDGE_FAMILIES)

/** Best score per candidate from hosted progress and seeded rows; no source carries per-candidate cost yet. */
export function evolveParetoCandidates(run: EvolveRunRecord): EvolveParetoCandidate[] {
  const best = new Map<string, number>()
  const keep = (id: string | undefined, score: number | null | undefined) => {
    if (!id || typeof score !== 'number' || !Number.isFinite(score)) {
      return
    }
    best.set(id, Math.max(score, best.get(id) ?? -Infinity))
  }
  for (const entry of run.hostedProgress?.recent ?? []) {
    if (entry.kind === 'evaluated' || entry.kind === 'frontier' || entry.kind === 'promoted') {
      keep(entry.candidateId, entry.score)
    }
  }
  for (const seeded of run.ledger?.seeded ?? []) {
    keep(seeded.candidate_id, seeded.combined_score)
  }
  return [...best].map(([id, score]) => ({ id, label: id, score, costUsd: null }))
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

function judgment(value: unknown): EvolveJudgment | null {
  const row = record(value)
  if (
    !row ||
    typeof row.id !== 'string' ||
    typeof row.judgeLabel !== 'string' ||
    !FAMILIES.has(String(row.judgeFamily)) ||
    !FAMILIES.has(String(row.candidateFamily)) ||
    (row.shownFirst !== 'baseline' && row.shownFirst !== 'candidate') ||
    !VERDICTS.has(String(row.verdict))
  ) {
    return null
  }
  return {
    id: String(row.id),
    judgeLabel: String(row.judgeLabel),
    judgeFamily: row.judgeFamily as EvolveJudgment['judgeFamily'],
    candidateFamily: row.candidateFamily as EvolveJudgment['candidateFamily'],
    shownFirst: row.shownFirst as EvolveJudgment['shownFirst'],
    verdict: row.verdict as EvolveJudgment['verdict'],
    swappedVerdict: VERDICTS.has(String(row.swappedVerdict))
      ? (row.swappedVerdict as EvolveJudgment['verdict'])
      : null,
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    rationale: typeof row.rationale === 'string' ? row.rationale : null
  }
}

// Why: omnisi-evolve bundles carry per-item paired votes without judge families; until the
// service adds per-judge rows (proposed: a top-level `judgments` array), nothing else is read.
export function evolveJudgmentsFromAuditBundle(bundle: unknown): EvolveJudgment[] {
  const rows = record(bundle)?.judgments
  return Array.isArray(rows)
    ? rows.map(judgment).filter((row): row is EvolveJudgment => row !== null)
    : []
}
