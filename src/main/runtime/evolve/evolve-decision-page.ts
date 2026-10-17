import {
  evolvePromotionRecommended,
  type EvolveWinnerMetrics
} from '../../../shared/evolve-decision-metrics'
import type { EvolveRunRecord } from '../../../shared/evolve-workflow'
import type {
  EvolveDecisionResolution,
  EvolveOutboxDecisionRecord
} from '../workflow-script/discover-omnios-outbox'

export type EvolveDecisionChoice = {
  value: EvolveDecisionResolution
  label: string
  detail: string
}

export function evolveDecisionChoices(
  decision: Pick<EvolveOutboxDecisionRecord, 'winnerCandidateId' | 'winnerDigest'>
): EvolveDecisionChoice[] {
  return [
    {
      value: 'promote_winner',
      label: 'Promote winning version',
      detail: `Advance ${decision.winnerCandidateId} (${decision.winnerDigest.slice(0, 12)}) into compounding seeds.`
    },
    {
      value: 'keep_incumbent',
      label: 'Keep current incumbent',
      detail: 'Do not promote this candidate; retain current baseline.'
    },
    {
      value: 'rerun_higher_budget',
      label: 'Run again with higher budget',
      detail: 'Keep incumbent and queue another Evolve pass with expanded budget.'
    }
  ]
}

/** Promote is recommended only on recorded passing evidence; otherwise keep the incumbent. */
export function recommendedEvolveChoice(
  decision: Pick<EvolveWinnerMetrics, 'blindAuditPassed'>
): EvolveDecisionResolution {
  return evolvePromotionRecommended(decision) ? 'promote_winner' : 'keep_incumbent'
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }
    return map[ch] ?? ch
  })
}

function fmtNum(val: number | null | undefined, digits = 3): string {
  return typeof val === 'number' && Number.isFinite(val) ? val.toFixed(digits) : '—'
}

/** Summary-first review page (Sal, 8 Oct 2026): top summary + recommended decision, details collapsed. */
export function renderEvolveDecisionHtml(
  record: EvolveRunRecord,
  decision: EvolveOutboxDecisionRecord
): string {
  const deltaStr =
    typeof decision.heldOutDelta === 'number'
      ? `${decision.heldOutDelta >= 0 ? '+' : ''}${decision.heldOutDelta.toFixed(3)}`
      : '—'
  const spendStr =
    typeof decision.spendUsd === 'number'
      ? `$${decision.spendUsd.toFixed(2)} (${decision.creditsSpent ?? 0} credits)`
      : '—'
  const promos = record.ledger?.promotions ?? []
  const seeds = record.ledger?.seeded ?? []
  const rubrics = record.ledger?.rubrics ?? []
  const recommended = recommendedEvolveChoice({
    blindAuditPassed: decision.blindAuditPassed ?? null
  })
  const choices = evolveDecisionChoices(decision)
    .map((choice) => {
      const mark = choice.value === recommended
      return `  <label class="choice"><input type="radio" name="evolve_decision" value="${choice.value}" data-key="${esc(`${decision.decisionId}:choice`)}"${mark ? ' checked' : ''}> <strong>${mark ? '(Recommended) ' : ''}${esc(choice.label)}</strong> — ${esc(choice.detail)}</label>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(`Evolve Decision — ${record.request.target} (${record.id})`)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #161616; background: #fafaf8; margin: 0; padding: 24px 18px 56px; }
  main { max-width: 780px; margin: 0 auto; }
  header, section, details { background: #fff; border: 1px solid #e4e2dc; border-radius: 6px; padding: 14px 16px; margin-bottom: 12px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .meta { font-size: 12px; color: #5c5b57; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 12px 0; }
  .metric { border: 1px solid #eceae4; border-radius: 5px; padding: 8px 10px; background: #fcfcfa; }
  .metric-label { font-size: 11px; color: #5c5b57; text-transform: uppercase; }
  .metric-val { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .choice { display: block; padding: 8px 10px; border: 1px solid #e4e2dc; border-radius: 5px; margin-top: 6px; cursor: pointer; }
  summary { cursor: pointer; font-weight: 600; font-size: 13px; }
  pre { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f1ec; padding: 10px; border-radius: 4px; overflow-x: auto; }
</style></head><body><main>
<header>
  <div class="meta">Evolve Convergence Review · ${esc(record.id)} ·Idempotency ${esc(decision.idempotencyKey)}</div>
  <h1>Decide whether to promote winning version ${esc(decision.winnerCandidateId)}</h1>
  <p>${esc(decision.summaryLine ?? '')}</p>
  <div class="metrics">
    <div class="metric"><div class="metric-label">Challenger vs Baseline</div><div class="metric-val">${esc(fmtNum(decision.challengerScore))} vs ${esc(fmtNum(decision.baselineScore))}</div></div>
    <div class="metric"><div class="metric-label">Held-out Delta</div><div class="metric-val">${esc(deltaStr)}</div></div>
    <div class="metric"><div class="metric-label">Blind Cross-Family Audit</div><div class="metric-val">${esc(decision.blindAuditScore ?? '—')}</div></div>
    <div class="metric"><div class="metric-label">Credits Spent</div><div class="metric-val">${esc(spendStr)}</div></div>
  </div>
</header>
<section data-decision-id="${esc(decision.decisionId)}">
  <strong>Decision required</strong>
${choices}
</section>
<details><summary>Candidate &amp; Promotion Evidence (${promos.length})</summary><pre>${esc(JSON.stringify({ best_so_far: record.ledger?.best_so_far, promotions: promos, summary: record.ledger?.summary }, null, 2))}</pre></details>
<details><summary>Compounding Lineage (${seeds.length} seeds, ${rubrics.length} rubrics)</summary><pre>${esc(JSON.stringify({ seed_from: record.ledger?.seed_from, seeded: seeds, rubric_from: record.ledger?.rubric_from, rubrics }, null, 2))}</pre></details>
<details><summary>Full Run &amp; Ledger Record (JSON)</summary><pre>${esc(JSON.stringify(record.ledger ?? {}, null, 2))}</pre></details>
</main></body></html>`
}
