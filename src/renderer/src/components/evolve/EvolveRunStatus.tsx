import type { ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import { evolveAge, evolveScore, evolveUsd, evolveVerdictLabel } from './evolve-run-text'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** What the ledger and the worker last said about the run. */
export function EvolveRunStatus({ run }: { run: EvolveRunRecord }) {
  const ledger = run.ledger
  const requested = ledger?.iterations?.requested ?? run.submitted?.iterations
  const evaluated = ledger?.iterations?.evaluated_mutations ?? 0
  const byStatus = Object.entries(ledger?.candidates?.by_status ?? {})
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ')
  const best = ledger?.best_so_far
  const budget = ledger?.budget
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{translate('evolve.status', 'Status')}</h3>
      {run.error && (
        <p role="alert" className="text-sm text-destructive">
          {run.error}
        </p>
      )}
      <dl className="grid gap-x-3 gap-y-1.5 text-xs sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Row label={translate('evolve.ledgerStatus', 'Ledger status')}>
          {ledger
            ? `${ledger.status}${ledger.failure_class ? ` (${ledger.failure_class})` : ''}`
            : translate('evolve.notRead', 'not read yet')}
        </Row>
        <Row label={translate('evolve.iterations', 'Iterations')}>
          {translate('evolve.iterationsValue', '{{evaluated}} of {{requested}} evaluated', {
            evaluated,
            requested: requested ?? '?'
          })}
        </Row>
        <Row label={translate('evolve.candidates', 'Candidates')}>
          {ledger?.candidates
            ? `${ledger.candidates.total}${byStatus ? ` (${byStatus})` : ''}`
            : '—'}
        </Row>
        <Row label={translate('evolve.bestSoFar', 'Best so far')}>
          {best ? (
            <>
              <code className="font-mono">{best.candidate_id}</code> ·{' '}
              {evolveScore(best.combined_score)}
            </>
          ) : (
            '—'
          )}
        </Row>
        {ledger?.summary?.stop_reason && (
          <Row label={translate('evolve.stopReason', 'Stop reason')}>
            {ledger.summary.stop_reason}
          </Row>
        )}
        <Row label={translate('evolve.budget', 'Budget')}>
          {budget
            ? translate('evolve.budgetValue', '{{spend}} of {{cap}} (group {{group}})', {
                spend: evolveUsd(budget.spend_usd ?? 0),
                cap: evolveUsd(budget.run_cap_usd),
                group: budget.group ?? '?'
              })
            : '—'}
        </Row>
        <Row label={translate('evolve.heartbeat', 'Heartbeat')}>
          {evolveAge(ledger?.times?.heartbeat_age_s)}
        </Row>
        <Row label={translate('evolve.worker', 'Worker')}>
          {run.worker
            ? translate('evolve.workerValue', 'pid {{pid}} · {{verdict}}{{detail}}', {
                pid: run.worker.pid,
                verdict: evolveVerdictLabel(run.contact?.verdict ?? 'unverifiable'),
                detail: run.contact?.detail ? ` (${run.contact.detail})` : ''
              })
            : translate('evolve.noWorker', 'not started')}
        </Row>
      </dl>
    </section>
  )
}
