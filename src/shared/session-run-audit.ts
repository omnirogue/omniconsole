import { effectiveSessionOutcomeBlock } from './session-outcome-block'
import { readSessionRun, type SessionRunPhase } from './session-run-lifecycle'
import type { SessionChain } from './session-chain-types'

/**
 * A read-only list of runs whose persisted record contradicts what the record itself proves. It
 * repairs nothing and special-cases nothing: every finding is an invariant any run can break, and
 * the host's ordinary reconciliation is what repairs the ones the evidence settles.
 */
export type SessionRunAuditFinding =
  /** Every outcome is proven, but the chain was never recorded as done. */
  | 'complete-not-recorded'
  /** Proven complete, but never sealed: a later drift could still un-finish it. */
  | 'complete-not-sealed'
  /** A blocked outcome no writer classified: it reads as failed until the host classifies it. */
  | 'unclassified-block'
  /** The chain says failed/waiting-with-error while its run reads as something else. */
  | 'state-disagrees-with-phase'
  /** A request is open for a run that no longer has the outcome, revision or attempt it names. */
  | 'stale-attention'
  /** Sealed, with a disposition that ran out of retries. */
  | 'disposition-failed'
  /**
   * Sealed while work queued behind its own review was still held (a build that sealed on the last
   * reply): the work never ran. The host releases it as a new run; the seal stands.
   */
  | 'sealed-with-held-continuation'

/** What the draft store holds behind a run's own review (`up-next-held-gates.ts`). */
export type SessionRunHeldWork = { reviewStepIds: readonly string[]; refused?: string }

export type SessionRunAuditRow = {
  chainId: string
  title: string
  state: SessionChain['state']
  phase: SessionRunPhase
  findings: SessionRunAuditFinding[]
  /** What ordinary reconciliation will do with it. `none` = ambiguous evidence stays as it is. */
  repair:
    | 'record-completion'
    | 'seal'
    | 'classify'
    | 'rewrite-state'
    | 'withdraw-attention'
    | 'release-continuation'
    | 'none'
  reasons: string[]
  updatedAt: number
}

const EXPECTED_STATE: Record<SessionRunPhase, SessionChain['state'][]> = {
  active: ['waiting', 'ready', 'launching'],
  recovering: ['waiting'],
  waiting: ['waiting'],
  'needs-you': ['waiting'],
  failed: ['failed'],
  completed: ['done']
}

export function auditSessionRuns(
  chains: readonly SessionChain[],
  now: number,
  /** The held work each run owns; a host without a draft store holds none. */
  held: (chain: SessionChain) => SessionRunHeldWork | null = () => null
): SessionRunAuditRow[] {
  const rows: SessionRunAuditRow[] = []
  for (const chain of chains) {
    const set = chain.outcomeSet
    // A cancelled run was stopped on purpose and is nobody's to repair.
    if (!set || chain.state === 'cancelled' || chain.quarantine) {
      continue
    }
    const run = readSessionRun(set, { now, planVersion: chain.planVersion ?? 1 })
    const findings: SessionRunAuditFinding[] = []
    const stepsDone = chain.currentIndex >= chain.steps.length
    if (run.phase === 'completed' && stepsDone && chain.state !== 'done') {
      findings.push('complete-not-recorded')
    }
    if (run.phase === 'completed' && stepsDone && !set.completion) {
      findings.push('complete-not-sealed')
    }
    if (
      !set.completion &&
      set.outcomes.some(
        (outcome) =>
          outcome.status === 'blocked' &&
          !outcome.block &&
          effectiveSessionOutcomeBlock(outcome, now) !== null
      )
    ) {
      findings.push('unclassified-block')
    }
    if (
      !findings.includes('complete-not-recorded') &&
      !(run.phase === 'completed' && !stepsDone) &&
      !EXPECTED_STATE[run.phase].includes(chain.state)
    ) {
      findings.push('state-disagrees-with-phase')
    }
    const open = (set.attention ?? []).filter((entry) => entry.state === 'open')
    const valid = new Set([...run.attention, ...run.awaitingOthers].map((entry) => entry.id))
    if (open.some((entry) => !valid.has(entry.id))) {
      findings.push('stale-attention')
    }
    if (set.completion && set.disposition?.state === 'failed') {
      findings.push('disposition-failed')
    }
    const stranded = set.completion ? held(chain) : null
    if (stranded?.reviewStepIds.length) {
      findings.push('sealed-with-held-continuation')
    }
    if (!findings.length) {
      continue
    }
    rows.push({
      chainId: chain.id,
      title: set.outcomes[0]?.title ?? chain.id,
      state: chain.state,
      phase: run.phase,
      findings,
      repair: findings.includes('complete-not-recorded')
        ? 'record-completion'
        : findings.includes('complete-not-sealed')
          ? 'seal'
          : findings.includes('unclassified-block')
            ? 'classify'
            : findings.includes('state-disagrees-with-phase')
              ? 'rewrite-state'
              : findings.includes('stale-attention')
                ? 'withdraw-attention'
                : findings.includes('sealed-with-held-continuation')
                  ? 'release-continuation'
                  : 'none',
      reasons: stranded?.refused ? [...run.reasons, stranded.refused] : run.reasons,
      updatedAt: set.updatedAt
    })
  }
  return rows
}
