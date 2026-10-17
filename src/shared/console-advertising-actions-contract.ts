import { z } from 'zod'
import { salesCompany, salesLevel } from './console-sales-ads-contract'
import type { ConsoleWorkflowResult } from './console-workflow-types'

export const advertisingActionId = z.string().regex(/^act_[a-f0-9]{32}$/)
export const advertisingActionRevision = z.string().regex(/^[a-f0-9]{64}$/)
export const advertisingActionVerb = z.enum(['pause', 'resume'])
export const advertisingActionTarget = z
  .object({
    domain: z.literal('advertising'),
    company: salesCompany,
    type: salesLevel,
    id: z.string().regex(/^[0-9]{5,30}$/)
  })
  .strict()
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@=-]{7,127}$/)
const jsonObject = z.record(z.string(), z.unknown())
const timestamp = z.string().datetime({ offset: true })
const nativeId = z.string().regex(/^[0-9]{5,30}$/)
const providerBudget = z
  .union([
    z.number().finite().nonnegative(),
    z
      .string()
      .refine(
        (value) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
      )
  ])
  .nullable()

export const advertisingActionSnapshot = z
  .object({
    id: z.string().min(1),
    objectId: nativeId,
    adAccountId: z.string().regex(/^act_[0-9]{5,30}$/),
    level: salesLevel,
    parentId: nativeId.nullable(),
    campaignId: nativeId.nullable(),
    status: z.string().min(1),
    effectiveStatus: z.string().min(1),
    dailyBudget: providerBudget,
    lifetimeBudget: providerBudget,
    currency: z.string().nullable(),
    budgetOwnerId: z.string().nullable(),
    ancestors: z.array(jsonObject).nullable()
  })
  .passthrough()

export const advertisingActionCapabilitiesRequest = z.object({ company: salesCompany }).strict()
export const advertisingActionScope = z
  .object({ target: advertisingActionTarget, verb: advertisingActionVerb })
  .strict()
export const advertisingActionPreviewRequest = advertisingActionScope.extend({
  parameters: z.object({}).strict().optional(),
  reason: z.string().max(1000).optional()
})
export const advertisingActionReadRequest = advertisingActionScope.extend({
  id: advertisingActionId
})
export const advertisingActionExecuteRequest = advertisingActionReadRequest.extend({
  expected_revision: advertisingActionRevision,
  idempotency_key: idempotencyKey,
  approved: z.literal(true)
})

const actionIdentity = z.object({
  id: advertisingActionId,
  protocol_version: z.literal('human-action.v1'),
  revision: advertisingActionRevision,
  principal: z.string().min(1),
  service: z.string().min(1).nullable(),
  actor_kind: z.string().min(1),
  target: advertisingActionTarget,
  verb: advertisingActionVerb,
  expected_version: z.string().min(1),
  created_at: timestamp,
  expires_at: timestamp,
  undo_of: advertisingActionId.nullable()
})

/** Fresh proposals retain the complete review; expiry never fills missing evidence. */
export const advertisingActionPreview = actionIdentity
  .extend({
    parameters: z.object({}).strict(),
    reason: z.string(),
    snapshot: advertisingActionSnapshot,
    transition: z.object({
      field: z.literal('status'),
      from: z.enum(['active', 'paused']),
      to: z.enum(['active', 'paused'])
    }),
    authority: z.object({ revision: z.string().min(1), details: jsonObject }),
    risk: z.object({ action_class: z.string().min(1), requires_confirmation: z.boolean() }),
    summary: z.string().min(1),
    financial_impact: z.object({
      currency: z.string().nullable(),
      profit_effect: z.literal('unproven'),
      daily_budget_ceiling: providerBudget,
      basis: z.string().min(1)
    }),
    undo: jsonObject,
    evidence: jsonObject
  })
  .refine(
    (value) =>
      value.snapshot.objectId === value.target.id &&
      value.snapshot.level === value.target.type &&
      (value.target.type === 'campaign' ||
        (value.snapshot.parentId !== null && value.snapshot.campaignId !== null)) &&
      (value.target.type !== 'adset' || value.snapshot.parentId === value.snapshot.campaignId) &&
      value.transition.to === (value.verb === 'pause' ? 'paused' : 'active'),
    'The preview does not preserve the native object, hierarchy or requested status.'
  )
const expiredPreview = actionIdentity.extend({ details_expired: z.literal(true) })

export const advertisingActionVerification = z
  .object({
    status: z.enum(['verified', 'mismatch', 'pending', 'unknown']),
    observed: jsonObject.optional(),
    source: z.string(),
    reference: z.string().nullable(),
    version: z.string(),
    checked_at: timestamp
  })
  .refine(
    (value) =>
      value.status !== 'verified' || (value.source.trim() !== '' && value.version.trim() !== ''),
    'Verified advertising state requires a named source and native version.'
  )
export const advertisingActionExecution = z.object({
  idempotency_key: idempotencyKey,
  requested_at: timestamp,
  dispatched_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
  outcome: z
    .object({
      accepted: z.boolean(),
      reference: z.string().nullable(),
      result: jsonObject.optional()
    })
    .nullable(),
  verification: advertisingActionVerification.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  details_expired: z.literal(true).optional()
})
export const advertisingActionReceipt = z
  .object({
    id: advertisingActionId,
    status: z.enum([
      'preview',
      'reserved',
      'dispatched',
      'accepted',
      'unverified',
      'verified',
      'not_issued'
    ]),
    preview: z.union([advertisingActionPreview, expiredPreview]),
    execution: advertisingActionExecution.nullable()
  })
  .refine((value) => value.id === value.preview.id, 'The receipt names a different proposal.')
  .refine(
    (value) => value.status !== 'verified' || value.execution?.verification?.status === 'verified',
    'The receipt claims verification without verified native evidence.'
  )

const actionCapability = z.object({
  verb: z.string().min(1),
  label: z.string(),
  target_types: z.array(z.string()),
  action_class: z.string().min(1),
  requires_confirmation: z.boolean()
})
export const advertisingActionCapabilities = z
  .object({ items: z.array(actionCapability) })
  .transform(({ items }) => ({
    items: items.flatMap((item) => {
      const verb = advertisingActionVerb.safeParse(item.verb)
      if (!verb.success) {
        return []
      }
      const targetTypes = item.target_types.flatMap((type) => {
        const parsed = salesLevel.safeParse(type)
        return parsed.success ? [parsed.data] : []
      })
      return targetTypes.length ? [{ ...item, verb: verb.data, target_types: targetTypes }] : []
    })
  }))

export type AdvertisingActionTarget = z.infer<typeof advertisingActionTarget>
export type AdvertisingActionScope = z.infer<typeof advertisingActionScope>
export type AdvertisingActionPreview = z.infer<typeof advertisingActionPreview>
export type AdvertisingActionReceipt = z.infer<typeof advertisingActionReceipt>
export type AdvertisingActionCapabilities = z.infer<typeof advertisingActionCapabilities>
export type AdvertisingActionPreviewRequest = z.infer<typeof advertisingActionPreviewRequest>
export type AdvertisingActionReadRequest = z.infer<typeof advertisingActionReadRequest>
export type AdvertisingActionExecuteRequest = z.infer<typeof advertisingActionExecuteRequest>
export type ConsoleAdvertisingActionPreview = AdvertisingActionPreview
export type ConsoleAdvertisingActionReceipt = AdvertisingActionReceipt

/** Main-only signed operations; scope fields on receipt requests are local fences. */
export type ConsoleAdvertisingActionsApi = {
  capabilities(
    args: z.infer<typeof advertisingActionCapabilitiesRequest>,
    expectedPrincipal?: string
  ): Promise<ConsoleWorkflowResult<AdvertisingActionCapabilities>>
  preview(
    args: AdvertisingActionPreviewRequest,
    expectedPrincipal?: string
  ): Promise<ConsoleWorkflowResult<AdvertisingActionPreview>>
  get(
    args: AdvertisingActionReadRequest,
    expectedPrincipal?: string
  ): Promise<ConsoleWorkflowResult<AdvertisingActionReceipt>>
  execute(
    args: AdvertisingActionExecuteRequest,
    expectedPrincipal?: string
  ): Promise<ConsoleWorkflowResult<AdvertisingActionReceipt>>
  verify(
    args: AdvertisingActionReadRequest,
    expectedPrincipal?: string
  ): Promise<ConsoleWorkflowResult<AdvertisingActionReceipt>>
}
