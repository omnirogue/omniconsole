import { z } from 'zod'
import { evolveLedgerStatusSchema } from '../../../shared/evolve-workflow'

export const promotionSummarySchema = z.object({
  decision: z.enum(['promoted', 'held', 'rolled_back']),
  candidateId: z.string().nullable().optional(),
  scoreDelta: z.number().nullable().optional(),
  auditSummary: z.string().nullable().optional(),
  promotedAt: z.string().nullable().optional()
})

const winnerArtifactSchema = z.object({
  candidateId: z.string(),
  programSha: z.string(),
  combinedScore: z.number().nullable().optional(),
  artifactRef: z.string().nullable().optional(),
  family: z.string().nullable().optional()
})

export const quoteResponseSchema = z.object({
  executionTier: z.enum(['hosted_pro', 'hosted_super_intelligence']),
  iterations: z.number().int().positive(),
  estimatedCredits: z.number().int().nonnegative(),
  ensembleFamilies: z.number().int().positive().default(4),
  includesKnockoutTournament: z.boolean().default(true),
  includesBlindAudit: z.boolean().default(true)
})

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const RUN_KEYS = {
  run_id: 'cloudRunId',
  spec_sha: 'specSha',
  execution_tier: 'executionTier'
} as const
const RUN_STATUS: Record<string, string> = {
  succeeded: 'done',
  cancelled: 'stopped',
  canceled: 'stopped'
}

/** omnisi-evolve-service answers with a snake_case `Run` (or `{ run, lease }`); camelCase passes. */
function normalizeRunResponse(raw: unknown): unknown {
  const body = isPlainRecord(raw) && isPlainRecord(raw.run) ? raw.run : raw
  if (!isPlainRecord(body)) {
    return raw
  }
  const out: Record<string, unknown> = { ...body }
  for (const [snake, camel] of Object.entries(RUN_KEYS)) {
    if (out[camel] == null && body[snake] != null) {
      out[camel] = body[snake]
    }
  }
  if (typeof out.status === 'string') {
    out.status = RUN_STATUS[out.status] ?? out.status
  }
  if (out.target === null) {
    delete out.target
  }
  return out
}

const hostedTier = z.enum(['hosted_pro', 'hosted_super_intelligence'])

export const startResponseSchema = z.preprocess(
  normalizeRunResponse,
  z.object({
    cloudRunId: z.string().min(1).max(128),
    specSha: z.string().default('hosted-spec'),
    target: z.string().optional(),
    executionTier: hostedTier.optional().catch(undefined),
    estimatedCredits: z.number().int().nonnegative().optional(),
    iterations: z.number().int().positive().optional(),
    usdCap: z.number().nonnegative().optional(),
    seedFrom: z.string().nullable().optional(),
    rubricFrom: z.string().nullable().optional(),
    ledger: evolveLedgerStatusSchema.optional().catch(undefined),
    promotionSummary: promotionSummarySchema.optional().catch(undefined),
    winnerArtifact: winnerArtifactSchema.optional().catch(undefined)
  })
)

export const pollResponseSchema = z.preprocess(
  normalizeRunResponse,
  z.object({
    cloudRunId: z.string().min(1).max(128).optional(),
    // A status this client does not know yet reads as still running.
    status: z.enum(['queued', 'running', 'done', 'failed', 'stopped']).optional().catch(undefined),
    ledger: evolveLedgerStatusSchema.optional().catch(undefined),
    promotionSummary: promotionSummarySchema.optional().catch(undefined),
    winnerArtifact: winnerArtifactSchema.optional().catch(undefined),
    error: z.string().nullable().optional().catch(undefined)
  })
)
