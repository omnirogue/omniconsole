// Wire schemas for `sessionOrganization.*`. Fields beyond the first release stay optional:
// windows, runtimes and CLIs update independently.

import { z } from 'zod'
import { SessionWorkflowAnchorRefSchema } from './session-workflow-anchor'
import {
  ORGANIZATION_CHANGE_KINDS,
  ORGANIZATION_EXECUTOR_KINDS,
  ORGANIZATION_LAUNCH_SOURCES,
  ORGANIZATION_PERSON_SURFACES,
  ORGANIZATION_TITLE_ORIGINS,
  ORGANIZATION_WIRE_APP_FEATURES,
  ORGANIZATION_WIRE_CHANGE_KINDS
} from './session-organization-change'

export const ORGANIZATION_MAX_TARGETS = 1000

const opId = z.string().trim().min(1).max(200)
const key = z.string().min(1).max(1000)
const perTarget = z.array(z.unknown()).max(ORGANIZATION_MAX_TARGETS)

export const OrganizationTargetSchema = z
  .object({
    sessionKey: key.optional(),
    tabId: key.optional(),
    paneKey: key.optional(),
    folderId: key.optional(),
    workflow: SessionWorkflowAnchorRefSchema.optional()
  })
  .strict()

// Why closed enums without `app/steward`: no caller may claim the app's own unattended authority.
export const OrganizationExecutorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), via: z.enum(ORGANIZATION_PERSON_SURFACES) }).strict(),
  z.object({ kind: z.literal('pane'), paneKey: key, title: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal('cli') }).strict(),
  z.object({ kind: z.literal('launch'), source: z.enum(ORGANIZATION_LAUNCH_SOURCES) }).strict(),
  z.object({ kind: z.literal('sync'), stamp: z.number().finite() }).strict(),
  z.object({ kind: z.literal('app'), feature: z.enum(ORGANIZATION_WIRE_APP_FEATURES) }).strict()
])

// Why wire kinds: main alone records a history-only kind (`sleep`); nobody prepares or settles it.
export const OrganizationChangeSchema = z
  .object({
    opId,
    kind: z.enum(ORGANIZATION_WIRE_CHANGE_KINDS),
    targets: z.array(OrganizationTargetSchema).max(ORGANIZATION_MAX_TARGETS),
    value: z.unknown(),
    values: perTarget.optional(),
    executor: OrganizationExecutorSchema,
    origin: z.enum(ORGANIZATION_TITLE_ORIGINS).optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
    request: z.string().trim().min(1).max(4000).optional(),
    evidence: z.string().trim().min(1).max(1000).optional(),
    expectedRevision: opId.optional(),
    undoOf: opId.optional()
  })
  .strict()

export const OrganizationPrepareParamsSchema = z
  .object({
    change: OrganizationChangeSchema,
    /** What each target held before, when the caller read it first (makes a reconciled op undoable). */
    before: perTarget.optional(),
    summary: z.string().trim().min(1).max(1000).optional()
  })
  .strict()

export const OrganizationSettleParamsSchema = z
  .object({
    phase: z.enum(['applied', 'failed']),
    /** A person's whole change; for a prepared one, its opId with the resolved targets and value. */
    change: OrganizationChangeSchema,
    before: perTarget.optional(),
    after: perTarget.optional(),
    error: z.string().trim().min(1).max(2000).optional(),
    summary: z.string().trim().min(1).max(1000).optional()
  })
  .strict()

/** By history key, or (newer CLIs) by the sidebar row a pane or tab names. */
export const OrganizationHistoryParamsSchema = z
  .object({
    key: key.optional(),
    /** Keys the same session was recorded under before its key resolved (`pane:…`, `tab:…`). */
    aliases: z.array(key).max(4).optional(),
    target: z.object({ paneKey: key.optional(), tabId: key.optional() }).strict().optional()
  })
  .strict()
  .refine((params) => Boolean(params.key || params.target?.paneKey || params.target?.tabId), {
    message: 'Name the session: a history key, or a pane or tab.'
  })

export const OrganizationRecentParamsSchema = z
  .object({
    /** Epoch ms; default the last 24 hours. */
    since: z.number().int().min(0).optional(),
    executors: z.array(z.enum(ORGANIZATION_EXECUTOR_KINDS)).max(10).optional(),
    kinds: z.array(z.enum(ORGANIZATION_CHANGE_KINDS)).max(20).optional(),
    limit: z.number().int().min(1).max(1000).optional()
  })
  .strict()

export const OrganizationUndoPlanParamsSchema = z.object({ opId }).strict()

export type OrganizationPrepareParams = z.infer<typeof OrganizationPrepareParamsSchema>
export type OrganizationSettleParams = z.infer<typeof OrganizationSettleParamsSchema>
export type OrganizationRecentParams = z.infer<typeof OrganizationRecentParamsSchema>
