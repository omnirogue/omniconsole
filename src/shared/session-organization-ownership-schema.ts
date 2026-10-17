// Wire schemas for the ownership calls in SESSION_ORGANIZATION_OWNERSHIP_RPC. New fields stay
// optional: the window, runtime and CLI update independently.

import { z } from 'zod'
import { ORGANIZATION_MAX_TARGETS } from './session-organization-change-schema'

const key = z.string().min(1).max(1000)
const opId = z.string().trim().min(1).max(200)
const field = z.enum(['placement', 'title'])

export const OwnershipSnapshotParamsSchema = z
  .object({ keys: z.array(key).max(ORGANIZATION_MAX_TARGETS).optional() })
  .strict()

export const OwnershipSyncStampsParamsSchema = z
  .object({
    stamps: z
      .array(z.object({ key, field, opId, stamp: z.number().finite().nonnegative() }).strict())
      .max(ORGANIZATION_MAX_TARGETS)
  })
  .strict()

export const OwnershipMigrateKeysParamsSchema = z
  .object({
    moves: z
      .array(z.object({ from: key, to: key, placementFrom: z.boolean() }).strict())
      .max(ORGANIZATION_MAX_TARGETS)
  })
  .strict()

export const OwnershipSeedParamsSchema = z
  .object({
    seeds: z
      .array(
        z
          .object({
            key,
            value: z.string().min(1).max(200),
            batchId: z.string().min(1).max(200),
            at: z.string().min(1).max(64)
          })
          .strict()
      )
      .max(ORGANIZATION_MAX_TARGETS)
  })
  .strict()
