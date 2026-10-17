/**
 * The relocation bundle's wire contract (part of `session-relocation.<provider>.v1`): the requesting
 * computer reads the source's exported files in chunks and writes them into the destination's
 * staging area, resuming at what the destination already holds. Chunks are base64 so every byte
 * survives; staging then checks every file against the manifest, so a transfer can fail but never
 * stage something partial or altered. docs/reference/session-host-control.md.
 */

import { z } from 'zod'
import {
  SESSION_HOST_RELOCATION_PROVIDERS,
  SESSION_RELOCATION_CAPABILITY_BY_PROVIDER,
  type SessionHostRelocationProvider
} from './session-host-capabilities'
import {
  requireSessionHostCapability,
  type SessionHostNegotiation
} from './session-host-negotiation'
import {
  isRelocationManifestPath,
  sessionHostConversationIdSchema,
  sessionHostOperationIdSchema
} from './session-host-payload-schema'
import type { SessionHostReceivedRefusal, SessionHostRefusal } from './session-host-refusal'
import { SessionHostRefusalReadSchema } from './session-host-reply-schema'

/** Raw bytes per chunk: well inside every transport's frame and reply budget once base64'd. */
export const RELOCATION_BUNDLE_CHUNK_BYTES = 256 * 1024
/** Refused beyond this; a conversation's native files are far smaller. */
export const RELOCATION_BUNDLE_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const bundleFile = {
  relocation: sessionHostOperationIdSchema,
  conversationId: sessionHostConversationIdSchema,
  provider: z.enum(SESSION_HOST_RELOCATION_PROVIDERS),
  path: z.string().refine(isRelocationManifestPath, 'A bundle path stays inside the bundle.')
}

export const SessionHostBundleReadParamsSchema = z
  .object({
    ...bundleFile,
    offset: z.number().int().min(0).max(RELOCATION_BUNDLE_MAX_FILE_BYTES),
    length: z.number().int().min(1).max(RELOCATION_BUNDLE_CHUNK_BYTES)
  })
  .strict()

export const SessionHostBundleWriteParamsSchema = z
  .object({
    ...bundleFile,
    offset: z.number().int().min(0).max(RELOCATION_BUNDLE_MAX_FILE_BYTES),
    /** The whole file's size from the manifest; nothing is written past it. */
    size: z.number().int().min(0).max(RELOCATION_BUNDLE_MAX_FILE_BYTES),
    base64: z
      .string()
      .max(Math.ceil(RELOCATION_BUNDLE_CHUNK_BYTES / 3) * 4)
      .refine((value) => BASE64.test(value), 'A chunk is base64.')
  })
  .strict()

export type SessionHostBundleReadParams = z.infer<typeof SessionHostBundleReadParamsSchema>
export type SessionHostBundleWriteParams = z.infer<typeof SessionHostBundleWriteParamsSchema>

export type SessionHostBundleReadResult =
  | { status: 'ok'; path: string; offset: number; size: number; base64: string }
  | { status: 'refused'; refusal: SessionHostRefusal }

/** `received` is how much of the file the destination holds; a writer resumes from there. */
export type SessionHostBundleWriteResult =
  | { status: 'ok'; path: string; received: number; accepted: boolean }
  | { status: 'refused'; refusal: SessionHostRefusal }

const refused = z.object({ status: z.literal('refused'), refusal: SessionHostRefusalReadSchema })

export const SessionHostBundleReadReplySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    path: z.string(),
    offset: z.number().int().min(0),
    size: z.number().int().min(0),
    base64: z.string().refine((value) => BASE64.test(value))
  }),
  refused
])

export const SessionHostBundleWriteReplySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    path: z.string(),
    received: z.number().int().min(0),
    accepted: z.boolean()
  }),
  refused
])

/** Both calls need owner control and that provider's relocation capability. */
export function requireRelocationBundleCapability(
  negotiation: SessionHostNegotiation,
  provider: SessionHostRelocationProvider
): SessionHostReceivedRefusal | null {
  return requireSessionHostCapability(
    negotiation,
    SESSION_RELOCATION_CAPABILITY_BY_PROVIDER[provider]
  )
}
