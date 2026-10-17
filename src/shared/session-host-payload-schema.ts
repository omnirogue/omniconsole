// Per-action payloads for `sessionHost.execute` / `sessionHost.reserve`. Strict: a payload can never
// carry authority (`actor`, `executor`, `person`, `steward`); the host derives that itself.

import { z } from 'zod'
import { canonicalJson } from './decision-contracts/decision-calibration-summary'
import { ORGANIZATION_TITLE_ORIGINS } from './session-organization-change'
import { SESSION_HOST_RELOCATION_PROVIDERS } from './session-host-capabilities'
import {
  isSessionHostConversationId,
  isSessionHostDigest,
  isSessionHostId,
  isSessionHostOperationId,
  isSessionHostOwnerEpoch,
  sessionHostDigest
} from './session-host-identity'

const text = (max: number) => z.string().trim().min(1).max(max)

export const sessionHostOperationIdSchema = z
  .string()
  .refine(isSessionHostOperationId, 'An operation id is <13-digit epoch ms>-<32 hex digits>.')
export const sessionHostConversationIdSchema = z
  .string()
  .refine(isSessionHostConversationId, 'A conversation id is conv_<32 hex digits>.')
export const sessionHostIdSchema = z
  .string()
  .refine(isSessionHostId, 'A host id is host_<32 hex digits>.')
export const sessionHostOwnerEpochSchema = z
  .number()
  .refine(isSessionHostOwnerEpoch, 'An owner epoch is a whole number from 1.')
export const sessionHostDigestSchema = z
  .string()
  .refine(isSessionHostDigest, 'A digest is sha256:<64 hex digits>.')

const providerIdentity = z.object({ agent: text(64), sessionId: text(256) }).strict()
const provider = z.enum(SESSION_HOST_RELOCATION_PROVIDERS)
const choice = z.number().int().min(1).max(25)

/** Per-session organization kinds a remote Mac may ask the owning host to commit. */
export const SESSION_HOST_ORGANIZE_KINDS = [
  'move',
  'save',
  'tag',
  'untag',
  'hide',
  'unhide',
  'snooze'
] as const

// Why no `..`, absolute, drive or backslash paths: an export must never escape its bundle root.
export function isRelocationManifestPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/^[A-Za-z]:/.test(path) &&
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused
    !/[\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

export const SessionHostRelocationManifestSchema = z
  .object({
    version: z.literal(1),
    provider,
    providerSessionId: text(256),
    files: z
      .array(
        z
          .object({
            path: z.string().refine(isRelocationManifestPath, 'A manifest path stays inside it.'),
            bytes: z.number().int().min(0),
            sha256: z.string().regex(/^[0-9a-f]{64}$/)
          })
          .strict()
      )
      .min(1)
      .max(10_000),
    digest: sessionHostDigestSchema
  })
  .strict()

export const SessionHostOwnershipGrantSchema = z
  .object({
    grantId: sessionHostOperationIdSchema,
    relocation: sessionHostOperationIdSchema,
    conversationId: sessionHostConversationIdSchema,
    fromHostId: sessionHostIdSchema,
    toHostId: sessionHostIdSchema,
    ownerEpoch: sessionHostOwnerEpochSchema,
    provider: providerIdentity,
    manifestDigest: sessionHostDigestSchema,
    issuedAt: z.number().int().min(0)
  })
  .strict()

const hostConversation = z
  .object({ hostId: sessionHostIdSchema, conversationId: sessionHostConversationIdSchema })
  .strict()
const relocation = { relocation: sessionHostOperationIdSchema, provider }
const workspace = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('git'),
      commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
      path: text(4096).optional()
    })
    .strict(),
  // Why required: a folder workspace needs an explicit accessible mapping on the destination.
  z.object({ kind: z.literal('folder'), path: text(4096) }).strict()
])

export const SESSION_HOST_PAYLOAD_SCHEMAS = {
  continue: z
    .object({
      answer: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('yes') }).strict(),
        z.object({ kind: z.literal('choose'), choice }).strict(),
        z.object({ kind: z.literal('prompt'), text: z.string().min(1).max(30_000) }).strict()
      ])
    })
    .strict(),
  ask: z
    .object({
      question: z.string().min(1).max(30_000),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(30 * 60_000)
        .optional()
    })
    .strict(),
  answer: z
    .object({
      /** The prompt fingerprint the caller saw; a changed prompt refuses. */
      expect: z.string().regex(/^[a-f0-9]{64}$/),
      answer: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('allow') }).strict(),
        z.object({ kind: z.literal('deny') }).strict(),
        z.object({ kind: z.literal('choose'), choice }).strict(),
        z.object({ kind: z.literal('text'), text: text(4000) }).strict()
      ])
    })
    .strict(),
  stop: z.object({ force: z.boolean().optional() }).strict(),
  restart: z.object({}).strict(),
  rename: z
    .object({ title: text(200), origin: z.enum(ORGANIZATION_TITLE_ORIGINS).optional() })
    .strict(),
  archive: z.object({}).strict(),
  unarchive: z.object({}).strict(),
  organize: z.object({ kind: z.enum(SESSION_HOST_ORGANIZE_KINDS), value: z.unknown() }).strict(),
  undo: z.object({ undoOf: text(200) }).strict(),
  'transfer.prepare-source': z
    .object({
      transfer: sessionHostOperationIdSchema,
      mode: z.enum(['handoff', 'consolidate']),
      target: z
        .object({
          hostId: sessionHostIdSchema,
          conversationId: sessionHostConversationIdSchema.optional()
        })
        .strict(),
      note: z.string().max(30_000).optional()
    })
    .strict(),
  'transfer.settle-source': z
    .object({
      transfer: sessionHostOperationIdSchema,
      outcome: z.enum(['accepted', 'abandoned']),
      /** Required for `accepted`: the target's durable acknowledgment. */
      targetReceipt: hostConversation
        .extend({ operationId: sessionHostOperationIdSchema })
        .strict()
        .optional()
    })
    .strict()
    .refine((value) => value.outcome !== 'accepted' || value.targetReceipt !== undefined, {
      message: 'An accepted transfer names the target receipt.'
    }),
  'relocate.prepare-destination': z
    .object({
      ...relocation,
      providerVersion: text(100),
      source: hostConversation.extend({ ownerEpoch: sessionHostOwnerEpochSchema }).strict(),
      workspace
    })
    .strict(),
  'relocate.freeze-source': z
    .object({ ...relocation, destination: z.object({ hostId: sessionHostIdSchema }).strict() })
    .strict(),
  'relocate.export': z.object(relocation).strict(),
  'relocate.stage': z
    .object({ ...relocation, manifest: SessionHostRelocationManifestSchema })
    .strict(),
  'relocate.relinquish': z
    .object({
      ...relocation,
      destination: z.object({ hostId: sessionHostIdSchema }).strict(),
      manifestDigest: sessionHostDigestSchema
    })
    .strict(),
  'relocate.resume': z.object({ ...relocation, grant: SessionHostOwnershipGrantSchema }).strict(),
  'wait.register': z
    .object({
      waiter: hostConversation,
      match: z.literal('result'),
      /** Epoch ms. Reaching it never satisfies the wait; it only ends it unmet. */
      deadline: z.number().int().min(0).optional()
    })
    .strict(),
  'wait.cancel': z.object({ registration: sessionHostOperationIdSchema }).strict(),
  /** A Mac's own automatic writer's exact text (its queue, Keep going, a chain, Up next). */
  deliver: z.object({ text: z.string().min(1).max(100_000), writer: text(64) }).strict()
} as const

/** Over provider, session id and every file (sorted by path); staging recomputes and compares it. */
export function sessionHostRelocationManifestDigest(
  manifest: Omit<SessionHostRelocationManifest, 'digest'>
): string {
  const files = [...manifest.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => [file.path, file.bytes, file.sha256])
  return sessionHostDigest(
    canonicalJson([
      'session-relocation-manifest/v1',
      manifest.provider,
      manifest.providerSessionId,
      files
    ])
  )
}

export type SessionHostPayloads = {
  [A in keyof typeof SESSION_HOST_PAYLOAD_SCHEMAS]: z.infer<
    (typeof SESSION_HOST_PAYLOAD_SCHEMAS)[A]
  >
}
export type SessionHostRelocationManifest = z.infer<typeof SessionHostRelocationManifestSchema>
