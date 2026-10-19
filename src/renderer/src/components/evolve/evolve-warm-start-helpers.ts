import type { EvolveRunRecord } from '../../../../shared/evolve-workflow'
import {
  estimateHostedEvolveCredits,
  findBestLocalWinnerSeed,
  type EvolveDraft,
  type LocalWinnerSeedCandidate
} from '../../../../shared/evolve-workflow-draft'

export const defaultEvolveWarmStartLabels = {
  title: 'Warm-start Evolve',
  description:
    'Seed a hosted run with your best completed local or fleet candidate for this target.',
  winner: 'Local winner',
  target: 'Target',
  run: 'Source run',
  candidate: 'Candidate',
  score: 'Best score',
  executionTier: 'Hosted tier',
  hostedPro: 'Hosted Pro',
  hostedSuperIntelligence: 'Hosted Super Intelligence',
  iterations: 'Estimated iterations',
  credits: 'Estimated credits',
  estimateHint: 'The credit estimate depends on the selected tier, target and iterations.',
  auditHint:
    'The hosted candidate must beat this baseline in a blind cross-family audit before promotion.',
  empty: 'No completed local or fleet winner is available for this target in this workspace.',
  cancel: 'Cancel',
  confirm: 'Start from local winner',
  pending: 'Starting…',
  error: 'The warm-start could not be started. Try again.',
  unavailable: '—',
  formatScore: (score: number): string => score.toFixed(4),
  formatCount: (count: number): string => count.toLocaleString()
}

export type EvolveWarmStartLabels = typeof defaultEvolveWarmStartLabels

export type EvolveWarmStartContext = Pick<EvolveDraft, 'target' | 'specPath'> & {
  worktreeId: string
}

/** Constrain the shared selector so its cross-target fallback cannot choose an unrelated seed. */
export function findEvolveWarmStartWinner(
  runs: readonly EvolveRunRecord[],
  context: EvolveWarmStartContext
): LocalWinnerSeedCandidate | undefined {
  const eligible = runs.filter((run) => {
    const candidateId =
      run.ledger?.summary?.best_candidate_id ?? run.ledger?.best_so_far?.candidate_id
    const score =
      run.ledger?.summary?.best_combined_score ?? run.ledger?.best_so_far?.combined_score
    return (
      run.worktreeId === context.worktreeId &&
      run.state === 'done' &&
      run.request.target === context.target &&
      (context.target !== 'spec' || run.request.specPath === context.specPath.trim()) &&
      (!run.request.executionTier || run.request.executionTier === 'local') &&
      Boolean(candidateId?.trim()) &&
      (score == null || Number.isFinite(score))
    )
  })
  return findBestLocalWinnerSeed(eligible, context.target)
}

export function createEvolveWarmStartDraft(
  draft: EvolveDraft,
  winner: LocalWinnerSeedCandidate
): EvolveDraft {
  const executionTier =
    draft.executionTier === 'hosted_pro' ? 'hosted_pro' : 'hosted_super_intelligence'
  const quote = estimateHostedEvolveCredits({
    executionTier,
    iterations: draft.iterations,
    target: draft.target
  })
  return {
    ...draft,
    runsOn: 'hosted',
    runsOnHost: undefined,
    runsOnHostId: undefined,
    executionTier,
    estimatedCredits: quote.estimatedCredits,
    seedFrom: winner.seedValue,
    seedFromRunId: winner.runId
  }
}
