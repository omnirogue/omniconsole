import type { EvolveRunRecord } from './evolve-workflow'
import type { LocalWorkflowChangedEvent } from './local-workflow-rpc'

const RUN_STATE: Record<EvolveRunRecord['state'], LocalWorkflowChangedEvent['state']> = {
  starting: 'running',
  running: 'running',
  done: 'completed',
  failed: 'failed',
  stopped: 'cancelled',
  // Contact lost too long to keep following: a person checks the host (shown as Needs you).
  unverifiable: 'recovery_required'
}

/** Where the run stands in a few words, for the sidebar row and the CLI's follow line. */
export function evolvePhase(record: EvolveRunRecord): string {
  const ledger = record.ledger
  if (record.state === 'starting') {
    return record.ledgerRunId ? 'Starting the worker' : 'Submitting the spec'
  }
  if (record.state === 'unverifiable') {
    return `Lost contact with ${record.host}`
  }
  if (!ledger || ledger.status === 'queued') {
    return 'Queued on the ledger'
  }
  const requested = ledger.iterations?.requested ?? record.submitted?.iterations
  const evaluated = ledger.iterations?.evaluated_mutations ?? 0
  if (ledger.status === 'running') {
    return requested ? `Evolving (${evaluated} of ${requested} mutations)` : 'Evolving'
  }
  const score = ledger.summary?.best_combined_score ?? ledger.best_so_far?.combined_score
  return `${ledger.status === 'done' ? 'Done' : 'Failed'}${typeof score === 'number' ? ` · best ${score.toFixed(4)}` : ''}`
}

/** The window broadcast for the tab showing this run; none when no tab does. */
export function evolveChangedEvent(record: EvolveRunRecord): LocalWorkflowChangedEvent | undefined {
  if (!record.conversationId) {
    return undefined
  }
  const requested = record.ledger?.iterations?.requested ?? record.submitted?.iterations ?? 0
  const evaluated = record.ledger?.iterations?.evaluated_mutations ?? 0
  return {
    conversationId: record.conversationId,
    executionId: record.id,
    preset: 'evolve',
    state: RUN_STATE[record.state],
    running: record.state === 'running' && record.ledger?.status === 'running' ? 1 : 0,
    completed: Math.min(evaluated, requested),
    total: requested,
    phase: evolvePhase(record),
    ...(record.placement.host ? { host: record.placement.host.name } : {}),
    ...(record.request.requestedBy ? { requestedBy: record.request.requestedBy } : {})
  }
}

/** The run as lines for a person: `omni workflow status evo_…` and the CLI's final report. */
export function evolveStatusLines(record: EvolveRunRecord): string[] {
  const ledger = record.ledger
  const lines = [
    `Evolve run ${record.id}: ${record.state}${record.error ? ` (${record.error})` : ''}`,
    `Spec ${record.spec} on ${record.host} from ${record.checkout}; submitted by ${record.submittedBy}`,
    ...(record.request.requestedBy
      ? [`Requested by ${record.request.requestedBy}: "${record.request.request ?? ''}"`]
      : []),
    record.ledgerRunId ? `Ledger run ${record.ledgerRunId}` : 'Not submitted to the ledger',
    ...(record.worker
      ? [
          `Worker pid ${record.worker.pid} on ${record.host}: ${record.contact?.verdict ?? 'unverifiable'}${record.contact?.detail ? ` (${record.contact.detail})` : ''}`
        ]
      : [])
  ]
  if (!ledger) {
    return lines
  }
  const budget = ledger.budget
  lines.push(
    `Ledger: ${ledger.status}${ledger.failure_class ? ` (${ledger.failure_class})` : ''} · ${evolvePhase(record)}`,
    ...(budget
      ? [
          `Spend ${budget.spend_usd ?? 0} of ${budget.run_cap_usd ?? '?'} (group ${budget.group ?? '?'})`
        ]
      : []),
    ...(ledger.best_so_far
      ? [
          `Best so far ${ledger.best_so_far.candidate_id} · ${ledger.best_so_far.combined_score ?? 'unscored'}`
        ]
      : []),
    `Seeded from ${ledger.seed_from ?? 'nothing (no --seed-from)'}: ${ledger.seeded?.length ?? 0} earlier candidate(s)`,
    ...(ledger.seeded ?? []).map(
      (seed) =>
        `  ${seed.source_run_id}/${seed.source_candidate_id} prior ${seed.prior_combined_score ?? '?'}${seed.prior_promoted ? ' (promoted)' : ''} → ${seed.combined_score ?? seed.status} here`
    ),
    ...(ledger.promotions ?? []).map(
      (promotion) => `Promotion: ${promotion.candidate_id} ${promotion.decision}`
    )
  )
  return lines
}
