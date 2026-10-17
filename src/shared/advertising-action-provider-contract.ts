import { z } from 'zod'
import {
  advertisingActionId,
  advertisingActionPreview,
  advertisingActionReceipt,
  advertisingActionRevision,
  advertisingActionVerb,
  advertisingActionTarget
} from './console-advertising-actions-contract'

const nativeId = z.string().regex(/^[0-9]{5,30}$/)
const accountId = z.string().regex(/^act_[0-9]{5,30}$/)
const timestamp = z.string().datetime({ offset: true })
const nativeStatus = z.enum(['ACTIVE', 'PAUSED'])
const minorBudget = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
const boundedText = z.string().min(1).max(200)
const localTarget = advertisingActionTarget.extend({ type: z.enum(['adset', 'ad']) }).strict()

export const localAdvertisingActionAncestor = z
  .object({
    objectId: nativeId,
    adAccountId: accountId,
    level: z.enum(['campaign', 'adset']),
    parentId: nativeId.nullable(),
    campaignId: nativeId.nullable(),
    status: nativeStatus,
    effectiveStatus: z.string().min(1).max(80),
    dailyBudget: minorBudget,
    lifetimeBudget: minorBudget
  })
  .strict()

/** Budgets are immutable native minor units, not the displayed daily ceiling. */
export const localAdvertisingActionSnapshot = z
  .object({
    id: boundedText,
    objectId: nativeId,
    adAccountId: accountId,
    level: z.enum(['adset', 'ad']),
    parentId: nativeId,
    campaignId: nativeId,
    status: nativeStatus,
    effectiveStatus: z.string().min(1).max(80),
    dailyBudget: minorBudget,
    lifetimeBudget: minorBudget,
    currency: z.string().regex(/^[A-Z]{3}$/),
    budgetOwnerId: nativeId.nullable(),
    ancestors: z.array(localAdvertisingActionAncestor).min(1).max(2)
  })
  .strict()
  .refine((snapshot) => {
    const [campaign, adset] = snapshot.ancestors
    return (
      campaign?.level === 'campaign' &&
      campaign.objectId === snapshot.campaignId &&
      campaign.parentId === null &&
      campaign.campaignId === null &&
      snapshot.ancestors.every((item) => item.adAccountId === snapshot.adAccountId) &&
      (snapshot.budgetOwnerId === null ||
        (snapshot.level === 'adset' && snapshot.budgetOwnerId === snapshot.objectId) ||
        snapshot.ancestors.some((item) => item.objectId === snapshot.budgetOwnerId)) &&
      (snapshot.level === 'adset'
        ? snapshot.parentId === snapshot.campaignId && snapshot.ancestors.length === 1
        : adset?.level === 'adset' &&
          adset.objectId === snapshot.parentId &&
          adset.parentId === snapshot.campaignId &&
          adset.campaignId === snapshot.campaignId)
    )
  }, 'The local snapshot does not preserve the native account and hierarchy.')

export const localAdvertisingActionPreview = z
  .object({
    id: advertisingActionId,
    protocol_version: z.literal('local-human-action.v1'),
    provider: z.literal('local.meta.graph'),
    revision: advertisingActionRevision,
    principal: boundedText,
    service: z.null(),
    actor_kind: z.literal('human'),
    routine_id: boundedText,
    run_id: boundedText,
    decision_id: advertisingActionRevision,
    source_revision: advertisingActionRevision,
    authority_revision: advertisingActionRevision,
    target: localTarget,
    verb: advertisingActionVerb,
    expected_version: advertisingActionRevision,
    created_at: timestamp,
    expires_at: timestamp,
    undo_of: z.null(),
    parameters: z.object({}).strict(),
    reason: z.string().max(2000),
    snapshot: localAdvertisingActionSnapshot,
    transition: z
      .object({
        field: z.literal('status'),
        from: z.enum(['active', 'paused']),
        to: z.enum(['active', 'paused'])
      })
      .strict(),
    authority: z
      .object({ revision: advertisingActionRevision, details: z.object({}).strict() })
      .strict(),
    risk: z
      .object({
        action_class: z.literal('external_reversible'),
        requires_confirmation: z.literal(true)
      })
      .strict(),
    summary: z.string().min(1).max(1200),
    financial_impact: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        profit_effect: z.literal('unproven'),
        daily_budget_ceiling: z.number().finite().nonnegative().nullable(),
        basis: z.string().min(1).max(1000)
      })
      .strict(),
    undo: z.object({ requires_new_approval: z.literal(true) }).strict(),
    evidence: z.object({ source: z.literal('local.meta.graph') }).strict()
  })
  .strict()
  .refine(
    (preview) =>
      preview.snapshot.objectId === preview.target.id &&
      preview.snapshot.level === preview.target.type &&
      preview.transition.from === preview.snapshot.status.toLowerCase() &&
      preview.transition.to === (preview.verb === 'pause' ? 'paused' : 'active') &&
      preview.transition.from !== preview.transition.to &&
      preview.authority.revision === preview.authority_revision &&
      preview.financial_impact.currency === preview.snapshot.currency &&
      Date.parse(preview.expires_at) > Date.parse(preview.created_at),
    'The local preview does not preserve its source, authority or exact status transition.'
  )

export const localAdvertisingActionVerification = z
  .object({
    status: z.enum(['verified', 'mismatch', 'pending', 'unknown']),
    claim: z.literal('target_state_observed'),
    causality: z.literal('unproven'),
    observed: localAdvertisingActionSnapshot.nullable(),
    source: z.literal('local.meta.graph'),
    reference: z.string().max(200).nullable(),
    version: advertisingActionRevision.nullable(),
    checked_at: timestamp
  })
  .strict()
  .refine(
    (value) => value.status !== 'verified' || (value.observed !== null && value.version !== null),
    'A verified local target state requires an independent native observation.'
  )

export const localAdvertisingActionReceipt = z
  .object({
    id: advertisingActionId,
    provider: z.literal('local.meta.graph'),
    status: z.enum([
      'preview',
      'reserved',
      'dispatched',
      'accepted',
      'unverified',
      'verified',
      'not_issued'
    ]),
    preview: localAdvertisingActionPreview,
    execution: z
      .object({
        idempotency_key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@=-]{7,127}$/),
        requested_at: timestamp,
        dispatched_at: timestamp.nullable(),
        completed_at: timestamp.nullable(),
        outcome: z
          .object({ accepted: z.boolean(), reference: z.string().max(200).nullable() })
          .strict()
          .nullable(),
        verification: localAdvertisingActionVerification.nullable(),
        error: z
          .object({ code: z.string().max(100), message: z.string().max(1000) })
          .strict()
          .optional()
      })
      .strict()
      .nullable()
  })
  .strict()
  .refine((value) => value.id === value.preview.id, 'The local receipt names a different preview.')
  .refine((value) => {
    const verification = value.execution?.verification
    if (value.status !== 'verified') {
      return verification?.status !== 'verified'
    }
    const observed = verification?.observed
    const expected = value.preview.snapshot
    return (
      verification?.status === 'verified' &&
      observed !== null &&
      observed !== undefined &&
      observed.objectId === expected.objectId &&
      observed.adAccountId === expected.adAccountId &&
      observed.level === expected.level &&
      observed.parentId === expected.parentId &&
      observed.campaignId === expected.campaignId &&
      observed.status === value.preview.transition.to.toUpperCase() &&
      observed.dailyBudget === expected.dailyBudget &&
      observed.lifetimeBudget === expected.lifetimeBudget &&
      observed.currency === expected.currency &&
      observed.budgetOwnerId === expected.budgetOwnerId &&
      JSON.stringify(observed.ancestors) === JSON.stringify(expected.ancestors)
    )
  }, 'The local receipt does not verify the exact target state and unchanged native controls.')

function providerMatchesProtocol(value: unknown, receipt = false): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  const preview = receipt ? record.preview : record
  if (typeof preview !== 'object' || preview === null) {
    return false
  }
  const proposal = preview as Record<string, unknown>
  return proposal.protocol_version === 'local-human-action.v1'
    ? proposal.provider === 'local.meta.graph' &&
        (!receipt || record.provider === 'local.meta.graph')
    : proposal.protocol_version === 'human-action.v1' &&
        !('provider' in proposal) &&
        !('provider' in record) &&
        !('authority_revision' in proposal) &&
        !('source_revision' in proposal)
}

/** Check the raw discriminator before the legacy schema can strip unknown fields. */
export const typedAdvertisingActionPreview = z
  .unknown()
  .refine(
    (value) => providerMatchesProtocol(value),
    'The advertising action provider is inconsistent.'
  )
  .pipe(z.union([localAdvertisingActionPreview, advertisingActionPreview]))
export const typedAdvertisingActionReceipt = z
  .unknown()
  .refine(
    (value) => providerMatchesProtocol(value, true),
    'The advertising receipt provider is inconsistent.'
  )
  .pipe(z.union([localAdvertisingActionReceipt, advertisingActionReceipt]))

export type LocalAdvertisingActionSnapshot = z.infer<typeof localAdvertisingActionSnapshot>
export type LocalAdvertisingActionAncestor = z.infer<typeof localAdvertisingActionAncestor>
export type LocalAdvertisingActionPreview = z.infer<typeof localAdvertisingActionPreview>
export type LocalAdvertisingActionVerification = z.infer<typeof localAdvertisingActionVerification>
export type LocalAdvertisingActionReceipt = z.infer<typeof localAdvertisingActionReceipt>
export type TypedAdvertisingActionPreview = z.infer<typeof typedAdvertisingActionPreview>
export type TypedAdvertisingActionReceipt = z.infer<typeof typedAdvertisingActionReceipt>
