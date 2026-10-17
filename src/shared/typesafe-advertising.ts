import { z } from 'zod'

export const advertisingDecisionKind = z.enum([
  'KEEP_RUNNING',
  'TURN_ON',
  'PAUSE',
  'INCREASE_BUDGET',
  'DECREASE_BUDGET',
  'NO_ACTION'
])
export type AdvertisingDecisionKind = z.infer<typeof advertisingDecisionKind>
export const advertisingCompany = z.enum(['omnirogue', 'betacorp'])
export const advertisingObjectType = z.enum(['campaign', 'adset', 'ad'])
const nativeId = z.string().regex(/^[0-9]{5,30}$/)
const accountId = z.string().regex(/^act_[0-9]{5,30}$/)
const revision = z.string().regex(/^[a-f0-9]{64}$/)
const metric = z.number().finite().nonnegative().nullable()

export const advertisingRoutinePolicy = z
  .object({
    company: advertisingCompany,
    accountId,
    allowedObjectTypes: z.array(advertisingObjectType).min(1).max(3).default(['adset', 'ad']),
    minConfidence: z.number().finite().min(0.5).max(1).default(0.8),
    maxEvidenceAgeSeconds: z.number().int().min(60).max(900).default(300)
  })
  .strict()
export type AdvertisingRoutinePolicy = z.infer<typeof advertisingRoutinePolicy>

export const advertisingTarget = z
  .object({
    company: advertisingCompany,
    accountId,
    objectType: advertisingObjectType,
    nativeId,
    campaignId: nativeId,
    adsetId: nativeId.nullable()
  })
  .strict()
  .superRefine((target, ctx) => {
    if (
      (target.objectType === 'campaign' &&
        (target.campaignId !== target.nativeId || target.adsetId !== null)) ||
      (target.objectType === 'adset' && target.adsetId !== target.nativeId) ||
      (target.objectType === 'ad' && target.adsetId === null)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The native hierarchy does not match the object level.'
      })
    }
  })
export type AdvertisingTarget = z.infer<typeof advertisingTarget>

export const advertisingMetrics = z
  .object({
    spend: metric,
    revenue: metric,
    purchases: metric,
    registrations: metric,
    leads: metric,
    addToCarts: metric,
    checkouts: metric,
    linkClicks: metric,
    impressions: metric,
    dailyBudget: metric,
    linkCpc: metric,
    roas: metric
  })
  .strict()

export const localMetaObservation = z
  .object({
    freshnessBasis: z.literal('completed_native_read'),
    collectedAt: z.string().datetime({ offset: true }),
    providerComputedAt: z.null(),
    dayFinalized: z.literal(false),
    attributionFinalized: z.literal(false)
  })
  .strict()

export const advertisingEvidence = z
  .object({
    source: z.enum(['console.sales.ads', 'console.coordinator.statistics', 'local.meta.graph']),
    target: advertisingTarget,
    name: z.string().max(1000),
    currency: z.string().min(1).max(12),
    status: z.enum(['ACTIVE', 'PAUSED']),
    effectiveStatus: z.string().min(1).max(80),
    // Local Graph replies do not provide the metric computation timestamp.
    measuredAt: z.string().datetime({ offset: true }).nullable(),
    fetchedAt: z.string().datetime({ offset: true }),
    observation: localMetaObservation.optional(),
    dateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateStop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1).max(100),
    leadEvent: z.string().max(100).nullable(),
    budgetOwnerId: nativeId.nullable().optional(),
    limitations: z.array(z.string().max(1000)).max(30).optional(),
    metrics: advertisingMetrics
  })
  .strict()
  .refine(
    (evidence) =>
      evidence.source === 'local.meta.graph'
        ? evidence.measuredAt === null && evidence.observation !== undefined
        : evidence.measuredAt !== null && evidence.observation === undefined,
    'The evidence must distinguish provider measurement from local collection time.'
  )
export type AdvertisingEvidence = z.infer<typeof advertisingEvidence>

export const boundAdvertisingDecision = z
  .object({
    id: revision,
    target: advertisingTarget,
    kind: advertisingDecisionKind,
    confidence: z.number().finite().min(0).max(1),
    probabilities: z.record(advertisingDecisionKind, z.number().finite().min(0).max(1)),
    evidence: advertisingEvidence,
    evidenceRevision: revision,
    reasoningSummary: z.string().min(1).max(2000),
    parameters: z.object({ status: z.enum(['ACTIVE', 'PAUSED']).optional() }).strict(),
    requiresHumanApproval: z.boolean(),
    recommendationOnly: z.boolean(),
    verificationRequirements: z.array(z.string().max(200)).max(10)
  })
  .strict()
  .refine(
    (decision) => decision.evidence.source !== 'local.meta.graph' || decision.recommendationOnly,
    'Local Meta evidence authorizes recommendations only.'
  )
export type BoundAdvertisingDecision = z.infer<typeof boundAdvertisingDecision>

export const advertisingDecisionEnvelope = z
  .object({
    protocol: z.literal('typesafe-advertising.v1'),
    routineId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    evaluatedAt: z.number().int().nonnegative(),
    principal: z.string().min(1).max(200),
    sourceRevision: revision,
    policy: advertisingRoutinePolicy,
    status: z.enum(['ready', 'blocked']),
    reason: z.string().max(1000).nullable(),
    provider: z.string().max(100).nullable(),
    model: z.string().max(200).nullable(),
    decisions: z.array(boundAdvertisingDecision).max(20)
  })
  .strict()
export type AdvertisingDecisionEnvelope = z.infer<typeof advertisingDecisionEnvelope>

export const advertisingDecisionLabels: Record<AdvertisingDecisionKind, string> = {
  KEEP_RUNNING: 'Keep running',
  TURN_ON: 'Turn on',
  PAUSE: 'Pause',
  INCREASE_BUDGET: 'Recommend budget increase',
  DECREASE_BUDGET: 'Recommend budget decrease',
  NO_ACTION: 'No action'
}

export const ADVERTISING_CANDIDATE_INSTRUCTIONS = `For advertising decision evaluation, include one fenced omni-advertising-candidates JSON array with at most 20 target selectors. Place this selector block before any required final legacy omni-actions block; preserve that legacy block as the last output with nothing after it. Preserve the routine's existing report and action instructions. Each selector must contain only company (omnirogue or betacorp), accountId (act_...), objectType (campaign, adset or ad), nativeId, campaignId, and adsetId (null for a campaign, its own ID for an ad set, its parent ad-set ID for an ad). Include exact native IDs from observed source data. Do not include metrics or action instructions in this block. The host independently fetches current source metrics and validates every target before evaluation. Recommendations never authorize a mutation.`
