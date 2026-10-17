import { z } from 'zod'
import {
  EVOLVE_DEFAULT_CHECKOUT,
  EVOLVE_EXECUTION_TIERS,
  EVOLVE_TARGET_IDS,
  evolveStartRequestSchema,
  type EvolveExecutionTier,
  type EvolveRunRecord,
  type EvolveStartRequest,
  type EvolveTarget,
  type HostedEvolveExecutionTier
} from './evolve-workflow'

/** An Evolve tab's form as typed: text fields stay text until Start converts them. */
export type EvolveDraft = {
  target: EvolveTarget
  specPath: string
  checkout: string
  iterations: string
  patience?: string
  seedFrom: string
  rubricFrom: string
  usdCap: string
  submittedBy: string
  runsOn?: 'fleet' | 'local' | 'hosted'
  runsOnHost?: string
  runsOnHostId?: string
  executionTier?: EvolveExecutionTier
  estimatedCredits?: number
  seedFromRunId?: string
}

export const evolveDraftSchema = z.object({
  target: z.enum(EVOLVE_TARGET_IDS),
  specPath: z.string(),
  checkout: z.string(),
  iterations: z.string(),
  patience: z.string().optional(),
  seedFrom: z.string(),
  rubricFrom: z.string(),
  usdCap: z.string(),
  submittedBy: z.string(),
  runsOn: z.enum(['fleet', 'local', 'hosted']).optional(),
  runsOnHost: z.string().optional(),
  runsOnHostId: z.string().optional(),
  executionTier: z.enum(EVOLVE_EXECUTION_TIERS).optional(),
  estimatedCredits: z.number().int().nonnegative().optional(),
  seedFromRunId: z.string().optional()
})

export function createEvolveDraft(): EvolveDraft {
  return {
    target: 'email-smoke',
    specPath: '',
    checkout: EVOLVE_DEFAULT_CHECKOUT,
    iterations: '',
    patience: '',
    seedFrom: '',
    rubricFrom: '',
    usdCap: '',
    submittedBy: '',
    runsOn: 'fleet',
    executionTier: 'local'
  }
}

function text(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

// Why Number(): a non-number stays NaN so the schema refuses it by field instead of dropping it.
function numeric(value: string): number | undefined {
  const trimmed = value.trim()
  return trimmed ? Number(trimmed) : undefined
}

export type HostedEvolveQuote = {
  executionTier: HostedEvolveExecutionTier
  iterations: number
  estimatedCredits: number
  ensembleFamilies: number
  includesKnockoutTournament: boolean
  includesBlindAudit: boolean
}

/** Deterministic local fallback quote when estimating credits before or without a cloud round-trip. */
export function estimateHostedEvolveCredits(input: {
  executionTier?: EvolveExecutionTier
  iterations?: number | string
  target?: EvolveTarget
}): HostedEvolveQuote {
  const tier: HostedEvolveExecutionTier =
    input.executionTier === 'hosted_pro' ? 'hosted_pro' : 'hosted_super_intelligence'
  const rawIterations =
    typeof input.iterations === 'number'
      ? input.iterations
      : Number(String(input.iterations ?? '').trim() || '10')
  const iterations =
    Number.isFinite(rawIterations) && rawIterations > 0 ? Math.min(Math.round(rawIterations), 500) : 10
  const targetWeight = input.target === 'email-smoke' ? 0.75 : 1
  const perIteration = tier === 'hosted_super_intelligence' ? 36 : 14
  const auditOverhead = tier === 'hosted_super_intelligence' ? 90 : 30
  const estimatedCredits = Math.max(
    25,
    Math.round((iterations * perIteration + auditOverhead) * targetWeight)
  )
  return {
    executionTier: tier,
    iterations,
    estimatedCredits,
    ensembleFamilies: tier === 'hosted_super_intelligence' ? 4 : 2,
    includesKnockoutTournament: tier === 'hosted_super_intelligence',
    includesBlindAudit: true
  }
}

export type LocalWinnerSeedCandidate = {
  runId: string
  ledgerRunId?: string
  target: string
  seedValue: string
  candidateId?: string
  bestScore?: number | null
}

/** Finds the highest-scoring local or fleet run to seed a Hosted Super Intelligence run. */
export function findBestLocalWinnerSeed(
  runs: readonly EvolveRunRecord[],
  preferredTarget?: EvolveTarget
): LocalWinnerSeedCandidate | undefined {
  const localRuns = runs.filter(
    (run) =>
      run.request.runsOn !== 'hosted' &&
      !run.cloudRunId &&
      (run.state === 'done' || Boolean(run.ledger?.best_so_far || run.ledger?.summary?.best_candidate_id))
  )
  if (localRuns.length === 0) {
    return undefined
  }

  const scoreOf = (run: EvolveRunRecord): number =>
    run.ledger?.summary?.best_combined_score ?? run.ledger?.best_so_far?.combined_score ?? -1

  const matchingTarget = preferredTarget
    ? localRuns.filter((run) => run.request.target === preferredTarget)
    : []
  const pool = matchingTarget.length > 0 ? matchingTarget : localRuns
  const sorted = [...pool].sort((a, b) => {
    const diff = scoreOf(b) - scoreOf(a)
    return diff !== 0 ? diff : b.updatedAt.localeCompare(a.updatedAt)
  })
  const best = sorted[0]
  if (!best) {
    return undefined
  }
  const bestTarget = best.request.target === 'spec' ? best.id : best.request.target
  return {
    runId: best.id,
    ledgerRunId: best.ledgerRunId,
    target: best.request.target,
    seedValue: bestTarget,
    candidateId: best.ledger?.summary?.best_candidate_id ?? best.ledger?.best_so_far?.candidate_id,
    bestScore: scoreOf(best) >= 0 ? scoreOf(best) : null
  }
}

/** The Start request a draft asks for, validated against the RPC's own schema. */
export function evolveStartRequestFromDraft(
  draft: EvolveDraft,
  context: { conversationId: string; worktreeId: string }
): ReturnType<typeof evolveStartRequestSchema.safeParse> {
  const runsOn = draft.runsOn ?? 'fleet'
  const isHosted = runsOn === 'hosted'
  const executionTier: EvolveExecutionTier = isHosted
    ? draft.executionTier === 'hosted_pro'
      ? 'hosted_pro'
      : 'hosted_super_intelligence'
    : 'local'
  const estimatedCredits = isHosted
    ? (draft.estimatedCredits ??
      estimateHostedEvolveCredits({
        executionTier,
        iterations: draft.iterations,
        target: draft.target
      }).estimatedCredits)
    : undefined

  const request: Partial<Record<keyof EvolveStartRequest, unknown>> = {
    target: draft.target,
    specPath: draft.target === 'spec' ? text(draft.specPath) : undefined,
    checkout: text(draft.checkout),
    iterations: numeric(draft.iterations),
    patience: numeric(draft.patience ?? ''),
    seedFrom: text(draft.seedFrom),
    rubricFrom: text(draft.rubricFrom),
    usdCap: numeric(draft.usdCap),
    submittedBy: text(draft.submittedBy),
    runsOn,
    runsOnHost: isHosted ? undefined : draft.runsOnHost,
    runsOnHostId: isHosted ? undefined : draft.runsOnHostId,
    executionTier,
    estimatedCredits,
    seedFromRunId: isHosted ? text(draft.seedFromRunId ?? '') : undefined,
    conversationId: context.conversationId,
    worktreeId: context.worktreeId
  }
  const defined = Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== undefined)
  )
  return evolveStartRequestSchema.safeParse(defined)
}
