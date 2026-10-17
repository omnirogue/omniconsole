import { z } from 'zod'
import type { ConsoleWorkflowResult } from './console-workflow-types'
import {
  accessCapability,
  capabilityPattern,
  catalogueCapability,
  nullableBool,
  nullableText,
  overrideId,
  shelfDigest,
  shelfExpiry,
  shelfReason
} from './console-access-primitives'
import { accessSectionSummary, accessTemplates, principalSections } from './console-access-sections'
import type { BulkAnswer, BulkChange } from './console-access-bulk'
import type { SectionsAccess } from './console-access-sections'

export {
  accessCapability,
  capabilityPattern,
  catalogueCapability,
  changeTargetRef,
  principalRef,
  shelfDigest,
  shelfQuery
} from './console-access-primitives'

export type {
  AccessCapability,
  CatalogueCapability,
  SectionAccess
} from './console-access-primitives'
export * from './console-access-sections'

/**
 * The Tool Shelf contract (2026-09-12): what the signed-in person may use through
 * the estate gateway, and — for the estate's super admins — what everybody else may.
 *
 * Every shape here is the hub's answer relayed by the console BFF
 * (`/api/access/mine`, `/api/admin/access/people[/{ref}]`), validated at the
 * desktop boundary so a routing or cache mix-up can never paint the wrong
 * person's reach. Capability ids, labels and reasons only — never a credential.
 */

export const accessOverride = z
  .object({
    id: z.string(),
    principal: z.string(),
    action: z.enum(['grant', 'deny']),
    capability: z.string(),
    reason: nullableText,
    issued_by: nullableText,
    expires_at: nullableText,
    expired: nullableBool,
    created_at: nullableText,
    updated_at: nullableText
  })
  .passthrough()
export type AccessOverride = z.infer<typeof accessOverride>

export const accessSource = z
  .object({
    layer: z.string(),
    name: z.string(),
    effect: z.string(),
    pattern: nullableText
  })
  .passthrough()

/** GET /api/access/mine — the caller's own effective grant, as the hub resolves it. */
export const myTools = z
  .object({
    principal: z.string(),
    kind: nullableText,
    role: nullableText,
    companies: z.array(z.string()).nullable().optional(),
    domains: z.array(z.string()).nullable().optional(),
    environments: z.array(z.string()).nullable().optional(),
    count: z.number().nullable().optional(),
    mode: nullableText,
    store_synced: nullableBool,
    policy_digest: nullableText,
    capabilities: z.array(accessCapability).default([]),
    search: z
      .object({
        query: nullableText,
        results: z.array(accessCapability).default([]),
        degraded: nullableBool
      })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough()
export type MyTools = z.infer<typeof myTools>

export const principalSummary = z
  .object({
    principal: z.string(),
    kind: nullableText,
    role: nullableText,
    level: z.number().nullable().optional(),
    aliases: z.array(z.string()).nullable().optional(),
    agent_role: nullableText,
    companies: z.array(z.string()).nullable().optional(),
    domains: z.array(z.string()).nullable().optional(),
    count: z.number().nullable().optional(),
    mode: nullableText,
    store_synced: nullableBool,
    super_admin: nullableBool,
    /**
     * The matrix row: this principal's EFFECTIVE reach per section, as the hub
     * resolved it (policy + overrides + floor). Optional because a hub that has
     * not been taught sections yet still answers, and the matrix then falls back
     * to the per-person editor rather than painting an empty grid.
     */
    sections: principalSections.optional(),
    overrides: z.array(accessOverride).default([])
  })
  .passthrough()
export type PrincipalSummary = z.infer<typeof principalSummary>

/** GET /api/admin/access/people/{ref} and the answer of a change: one shelf, whole. */
export const personShelf = myTools
  .extend({
    digest: z.string(),
    overrides: z.array(accessOverride).default([]),
    sources: z.record(z.string(), z.array(accessSource)).default({}),
    summary: principalSummary.optional(),
    saved: accessOverride.nullable().optional(),
    removed: accessOverride.nullable().optional(),
    sync: z
      .array(
        z
          .object({
            principal: z.string(),
            added: z.array(z.string()).default([]),
            removed: z.array(z.string()).default([]),
            mode: nullableText
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough()
export type PersonShelf = z.infer<typeof personShelf>

export const catalogueConnector = z
  .object({
    id: z.string(),
    label: nullableText,
    group: nullableText,
    capabilities: z.array(catalogueCapability).default([])
  })
  .passthrough()
export type CatalogueConnector = z.infer<typeof catalogueConnector>

/** GET /api/admin/access/people — every principal, the floor, the catalogue. */
export const peopleAccess = z
  .object({
    schema_version: z.number().nullable().optional(),
    digest: z.string(),
    super_admins: z.array(z.string()).default([]),
    hard_deny: z.array(z.string()).default([]),
    principals: z.array(principalSummary).default([]),
    catalogue: z
      .object({
        connectors: z.array(catalogueConnector).default([]),
        bundles: z.record(z.string(), z.array(z.string())).optional()
      })
      .passthrough(),
    /** The matrix columns and the named shelf shapes, carried with the people. */
    sections: z.array(accessSectionSummary).optional(),
    templates: accessTemplates.optional()
  })
  .passthrough()
export type PeopleAccess = z.infer<typeof peopleAccess>

const reason = shelfReason
export const shelfChange = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('grant'),
      capability: capabilityPattern,
      reason,
      expires_at: shelfExpiry.optional(),
      expected_digest: shelfDigest
    })
    .strict(),
  z
    .object({
      op: z.literal('deny'),
      capability: capabilityPattern,
      reason,
      expected_digest: shelfDigest
    })
    .strict(),
  z
    .object({
      op: z.literal('remove'),
      override_id: overrideId,
      expected_digest: shelfDigest
    })
    .strict()
])
export type ShelfChange = z.infer<typeof shelfChange>

/** The desktop's Tool Shelf surface. Every call is signed in main as the person. */
export type ConsoleAccessApi = {
  /** My own tools; `q` searches them by intent. */
  mine: (args?: { q?: string }) => Promise<ConsoleWorkflowResult<MyTools>>
  /** Everybody (super admins only — the hub decides). */
  people: () => Promise<ConsoleWorkflowResult<PeopleAccess>>
  /** One principal's shelf (super admins only). */
  person: (args: { ref: string }) => Promise<ConsoleWorkflowResult<PersonShelf>>
  /** Grant, deny or remove one standing override (super admins only). */
  change: (args: {
    ref: string
    change: ShelfChange
  }) => Promise<ConsoleWorkflowResult<PersonShelf>>
  /** The derived sections, their capabilities and the templates (super admins only). */
  sections: () => Promise<ConsoleWorkflowResult<SectionsAccess>>
  /**
   * Several shelves in one all-or-nothing change: explicit rows, a template, or a
   * whole column of the matrix. `dry_run` asks the hub for the diff and writes
   * nothing, which is how a CSV import is shown before it is applied.
   */
  bulk: (args: { change: BulkChange }) => Promise<ConsoleWorkflowResult<BulkAnswer>>
}
