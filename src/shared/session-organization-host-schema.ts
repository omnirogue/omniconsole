// Wire schemas for the window's side of headless organization (SESSION_ORGANIZATION_HOST_RPC).
// Only this computer's own window calls them; new fields stay optional.

import { z } from 'zod'
import { ORGANIZATION_TITLE_ORIGINS } from './session-organization-change'

export const SESSION_ORGANIZATION_HOST_RPC = {
  /** Headless changes the window has not adopted yet. */
  pending: 'sessionOrganization.hostPending',
  /** What the window adopted, and where it held another value. */
  adopted: 'sessionOrganization.hostAdopted',
  /** The window's current values, imported before automation is admitted. */
  migrate: 'sessionOrganization.hostMigrate'
} as const

export const HOST_ORGANIZATION_MIGRATION_BATCH = 500

const key = z.string().min(1).max(1000)
const opId = z.string().trim().min(1).max(200)

export const HostOrganizationAdoptedParamsSchema = z
  .object({
    adopted: z.array(opId).max(1000),
    conflicts: z.array(z.object({ opId, key, value: z.unknown() }).strict()).max(1000)
  })
  .strict()

const HostOrganizationValuesSchema = z
  .object({
    placement: z.string().min(1).max(200).nullable().optional(),
    archived: z.boolean().optional(),
    title: z.string().max(1000).nullable().optional(),
    titleOrigin: z.enum(ORGANIZATION_TITLE_ORIGINS).optional(),
    tags: z.array(z.string().min(1).max(200)).max(100).optional(),
    hidden: z.boolean().optional(),
    snooze: z.number().finite().nullable().optional(),
    // Why its own batch from the window: this schema is strict, so an older main refuses it whole.
    deleted: z.boolean().optional()
  })
  .strict()

export const HostOrganizationMigrateParamsSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            key,
            digest: z
              .string()
              .regex(/^[0-9a-f]{24}$/)
              .optional(),
            values: HostOrganizationValuesSchema
          })
          .strict()
      )
      .max(HOST_ORGANIZATION_MIGRATION_BATCH),
    complete: z.boolean().optional()
  })
  .strict()
