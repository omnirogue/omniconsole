import { z } from 'zod'
import {
  capabilityPattern,
  changeTargetRef,
  nullableText,
  overrideId,
  sectionKey,
  shelfDigest,
  shelfExpiry,
  shelfReason
} from './console-access-primitives'
import { accessOverride, peopleAccess } from './console-access-contract'
import { principalSectionState } from './console-access-sections'

/**
 * Changing several shelves at once (CONTRACT §B, `POST /people/bulk` behind the
 * console's `PATCH /api/admin/access/people`).
 *
 * Three shapes, never mixed: a list of explicit changes, a template applied to
 * named people, or one column of the matrix turned on or off. The hub applies the
 * whole request or none of it, against the digest the reader was looking at, and
 * every row it writes goes through the same validation and audit path as a single
 * override. `dry_run` asks for the diff and writes nothing.
 *
 * The body carries no discriminator of its own — the hub reads the shape — so the
 * union here is by shape too, and each arm is `.strict()`: an extra key, or two of
 * the three intents in one body, never leaves the desktop.
 */

const reason = shelfReason
const base = {
  reason,
  expected_digest: shelfDigest,
  dry_run: z.boolean().optional()
}

/** One row of an explicit bulk change. `remove` names a row; the others name a target. */
export const bulkChangeRow = z.discriminatedUnion('action', [
  z
    .object({
      principal: changeTargetRef,
      action: z.literal('grant'),
      target: capabilityPattern,
      expires_at: shelfExpiry.nullable().optional()
    })
    .strict(),
  z
    .object({
      principal: changeTargetRef,
      action: z.literal('deny'),
      target: capabilityPattern
    })
    .strict(),
  z
    .object({
      principal: changeTargetRef,
      action: z.literal('remove'),
      override_id: overrideId
    })
    .strict()
])
export type BulkChangeRow = z.infer<typeof bulkChangeRow>

/** A whole column of the matrix: one section's reads or writes, on or off. */
export const bulkColumn = z
  .object({
    section: sectionKey,
    access: z.enum(['read', 'write']),
    on: z.boolean()
  })
  .strict()
export type BulkColumn = z.infer<typeof bulkColumn>

/** A template is named by a stable id, the same shape a section key has. */
export const templateName = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/)
const principals = z.array(changeTargetRef).min(1).max(200)

export const bulkChange = z.union([
  z.object({ ...base, changes: z.array(bulkChangeRow).min(1).max(500) }).strict(),
  z.object({ ...base, template: templateName, principals }).strict(),
  // Why principals may be absent: a column with no named people is every human
  // principal, which is the hub's default and the one the header toggle means.
  z.object({ ...base, column: bulkColumn, principals: principals.optional() }).strict()
])
export type BulkChange = z.infer<typeof bulkChange>

/**
 * A change as the hub echoes it back, normalised. Deliberately loose where the
 * request is strict: the hub may add fields (a resolved principal, a computed
 * target) and an answer that says MORE than was asked is not a malformed answer.
 */
export const bulkChangeEcho = z
  .object({
    principal: z.string(),
    action: z.string(),
    target: nullableText,
    override_id: nullableText,
    expires_at: nullableText
  })
  .passthrough()

export const bulkDiffRow = z
  .object({
    principal: z.string(),
    section: nullableText,
    target: nullableText,
    action: nullableText,
    before: principalSectionState.nullable().optional(),
    after: principalSectionState.nullable().optional()
  })
  .passthrough()
export type BulkDiffRow = z.infer<typeof bulkDiffRow>

/** The answer to a bulk change — including the whole people payload after it. */
export const bulkAnswer = z
  .object({
    digest: z.string(),
    dry_run: z.boolean().default(false),
    reason: nullableText,
    changes: z.array(bulkChangeEcho).default([]),
    diff: z.array(bulkDiffRow).default([]),
    applied: z.array(accessOverride).default([]),
    removed: z.array(accessOverride).default([]),
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
      .optional(),
    people: peopleAccess.nullable().optional()
  })
  .passthrough()
export type BulkAnswer = z.infer<typeof bulkAnswer>
