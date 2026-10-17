/**
 * The `t` kind of account-sync document: steward metadata (ownership receipts, permanent
 * revocations, title origins, folder policy overrides, bounded history, result references,
 * conversation aliases, pending intents). Folder (`f`) and session (`s`) documents are unchanged,
 * so older clients keep their data; their `parseDeviceDocKey` never matches `t`, so they neither
 * read nor write it. Sync receipts describe execution; they never grant it.
 */

import { z } from 'zod'
import { ACCOUNT_SYNC_VALUE_MAX_BYTES, accountSyncValueSize } from './account-sync-types'
import { canonicalJson } from './decision-contracts/decision-calibration-summary'
import { ORGANIZATION_TITLE_ORIGINS } from './session-organization-change'
import {
  isSessionHostConversationId,
  isSessionHostId,
  sessionHostDigest
} from './session-host-identity'

export const SESSION_HOST_SYNC_DOC_KIND = 't' as const
export const SESSION_HOST_SYNC_DOC_VERSION = 1 as const
/** The same ceiling folder and session documents have: 256 × 32 KB per computer. */
export const SESSION_HOST_SYNC_MAX_DOCS = 256
export const SESSION_HOST_SYNC_HISTORY_PER_SESSION = 20

const DEVICE = /^[0-9a-f]{8}$/
const KEY = /^omni-ide\.sync\.d\.([0-9a-f]{8})\.t\.(\d{1,3})$/

/** Each computer (or a Mac forwarding a relay's outbox) writes only its own `t` documents. */
export function sessionHostSyncDocKey(device: string, index: number): string {
  if (
    !DEVICE.test(device) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= SESSION_HOST_SYNC_MAX_DOCS
  ) {
    throw new Error('A steward sync document needs an 8-hex device and an index below 256')
  }
  return `omni-ide.sync.d.${device}.${SESSION_HOST_SYNC_DOC_KIND}.${index}`
}

export function parseSessionHostSyncDocKey(key: string): { device: string; index: number } | null {
  const match = KEY.exec(key)
  const index = Number(match?.[2])
  return match && index < SESSION_HOST_SYNC_MAX_DOCS ? { device: match[1]!, index } : null
}

const digest = z.string().regex(/^[0-9a-f]{24}$/)
const opId = z.string().min(1).max(200)
const at = z.number().finite().min(0)
const field = z.enum(['placement', 'title'])
const hostId = z.string().refine(isSessionHostId)

/** Reduce-only: an override can switch automation off or lower caps, never relax a hard stop. */
export const SessionHostFolderPolicySchema = z.looseObject({
  automation: z.literal('off').optional(),
  relocation: z.literal('off').optional(),
  safeYesPerDay: z.number().int().min(0).max(3).optional(),
  nudges: z.number().int().min(0).max(2).optional()
})
export type SessionHostFolderPolicy = z.infer<typeof SessionHostFolderPolicySchema>
const KNOWN_POLICY_KEYS = new Set(['automation', 'relocation', 'safeYesPerDay', 'nudges'])

// Why loose objects: a newer build's optional field on a known entry survives this build's rewrite.
const ENTRY_SCHEMAS = {
  own: z.looseObject({
    k: z.literal('own'),
    s: digest,
    f: field,
    r: opId,
    v: z.string().max(1000).nullable(),
    op: opId,
    h: hostId.optional(),
    at
  }),
  rev: z.looseObject({
    k: z.literal('rev'),
    s: digest,
    f: field,
    op: opId,
    why: z.string().max(200),
    at
  }),
  title: z.looseObject({
    k: z.literal('title'),
    s: digest,
    o: z.enum(ORGANIZATION_TITLE_ORIGINS),
    r: opId,
    at
  }),
  pol: z.looseObject({
    k: z.literal('pol'),
    d: z.string().min(1).max(64),
    p: SessionHostFolderPolicySchema,
    at
  }),
  hist: z.looseObject({
    k: z.literal('hist'),
    s: digest,
    op: opId,
    ch: z.string().min(1).max(40),
    by: z.string().min(1).max(40),
    h: hostId.optional(),
    at,
    sum: z.string().max(200).optional()
  }),
  res: z.looseObject({
    k: z.literal('res'),
    s: digest,
    ref: z.string().min(1).max(200),
    h: hostId,
    at
  }),
  alias: z.looseObject({
    k: z.literal('alias'),
    s: digest,
    c: z.string().refine(isSessionHostConversationId),
    h: hostId,
    at
  }),
  /** Explicitly pending until the owner's `hist` entry with the same `op` lands; never shown as applied. */
  int: z.looseObject({
    k: z.literal('int'),
    s: digest,
    op: opId,
    ch: z.string().min(1).max(40),
    v: z.unknown().optional(),
    at
  })
} as const

export type SessionHostSyncEntryKind = keyof typeof ENTRY_SCHEMAS
export type SessionHostSyncEntry = z.infer<(typeof ENTRY_SCHEMAS)[SessionHostSyncEntryKind]>
export const SESSION_HOST_SYNC_ENTRY_KINDS = Object.keys(
  ENTRY_SCHEMAS
) as SessionHostSyncEntryKind[]

/** One entry per id: history merges by operation id; revocations are keyed apart and never evicted. */
export function sessionHostSyncEntryId(entry: SessionHostSyncEntry): string {
  switch (entry.k) {
    case 'own':
      return `own:${entry.s}:${entry.f}`
    case 'rev':
      return `rev:${entry.s}:${entry.f}:${entry.op}`
    case 'title':
      return `title:${entry.s}`
    case 'pol':
      return `pol:${entry.d}`
    case 'hist':
      return `hist:${entry.op}`
    case 'res':
      return `res:${entry.s}`
    case 'alias':
      return `alias:${entry.c}:${entry.s}`
    case 'int':
      return `int:${entry.op}`
  }
}

/** `opaque`: entries of kinds this build does not know, kept byte-for-byte for the next writer. */
export type SessionHostSyncDoc = {
  entries: Record<string, SessionHostSyncEntry>
  opaque: Record<string, unknown>
}

export type SessionHostSyncDocRead =
  | { status: 'read'; doc: SessionHostSyncDoc }
  /** Written by a newer version: never merged, and never overwritten by this build. */
  | { status: 'newer'; version: number }
  | { status: 'unreadable' }

export function parseSessionHostSyncDoc(value: unknown): SessionHostSyncDocRead {
  const record = value as { v?: unknown; e?: unknown } | null
  if (typeof record?.v === 'number' && record.v > SESSION_HOST_SYNC_DOC_VERSION) {
    return { status: 'newer', version: record.v }
  }
  if (record?.v !== SESSION_HOST_SYNC_DOC_VERSION || !record.e || typeof record.e !== 'object') {
    return { status: 'unreadable' }
  }
  const doc: SessionHostSyncDoc = { entries: {}, opaque: {} }
  for (const [id, raw] of Object.entries(record.e as Record<string, unknown>)) {
    const kind = (raw as { k?: unknown } | null)?.k
    if (typeof kind !== 'string' || id.length > 400) {
      continue
    }
    if (!Object.hasOwn(ENTRY_SCHEMAS, kind)) {
      doc.opaque[id] = raw
      continue
    }
    const parsed = ENTRY_SCHEMAS[kind as SessionHostSyncEntryKind].safeParse(raw)
    // Why drop a known-kind entry under the wrong id: it would shadow the real one in a merge.
    if (parsed.success && sessionHostSyncEntryId(parsed.data) === id) {
      doc.entries[id] = parsed.data
    }
  }
  return { status: 'read', doc }
}

export function sessionHostSyncDocValue(doc: SessionHostSyncDoc): {
  v: 1
  e: Record<string, unknown>
} {
  return { v: SESSION_HOST_SYNC_DOC_VERSION, e: { ...doc.opaque, ...doc.entries } }
}

/** A device never replaces its own document that a newer version of itself wrote. */
export function mayRewriteSessionHostSyncDoc(stored: unknown): boolean {
  return stored === undefined || parseSessionHostSyncDoc(stored).status !== 'newer'
}

const stampOf = (entry: unknown) => {
  const value = (entry as { at?: unknown } | null)?.at
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Later `at` wins; a tie goes to the larger canonical JSON, so every computer picks the same one. */
function newer(left: unknown, right: unknown): boolean {
  const [a, b] = [stampOf(left), stampOf(right)]
  return a !== b ? a > b : canonicalJson(left) > canonicalJson(right)
}

export function mergeSessionHostSyncDocs(
  left: SessionHostSyncDoc,
  right: SessionHostSyncDoc
): SessionHostSyncDoc {
  const pick = <T>(ours: Record<string, T>, theirs: Record<string, T>) => {
    const merged = { ...ours }
    for (const [id, entry] of Object.entries(theirs)) {
      if (!(id in merged) || newer(entry, merged[id])) {
        merged[id] = entry
      }
    }
    return merged
  }
  return { entries: pick(left.entries, right.entries), opaque: pick(left.opaque, right.opaque) }
}

/**
 * Bounded history: the newest `hist` entries per session, and intents the owner has answered are
 * dropped. Revocations, ownership and unknown kinds are never evicted here.
 */
export function boundSessionHostSyncHistory(doc: SessionHostSyncDoc): SessionHostSyncDoc {
  const entries: Record<string, SessionHostSyncEntry> = {}
  const history = new Map<string, [string, SessionHostSyncEntry][]>()
  for (const [id, entry] of Object.entries(doc.entries)) {
    if (entry.k === 'hist') {
      history.set(entry.s, [...(history.get(entry.s) ?? []), [id, entry]])
    } else if (!(entry.k === 'int' && `hist:${entry.op}` in doc.entries)) {
      entries[id] = entry
    }
  }
  for (const rows of history.values()) {
    rows.sort(([, a], [, b]) => (newer(a, b) ? -1 : 1))
    for (const [id, entry] of rows.slice(0, SESSION_HOST_SYNC_HISTORY_PER_SESSION)) {
      entries[id] = entry
    }
  }
  return { entries, opaque: doc.opaque }
}

/** An override naming a restriction this build does not know turns automation off for the folder. */
export function effectiveSessionHostFolderPolicy(
  policy: SessionHostFolderPolicy
): SessionHostFolderPolicy {
  return Object.keys(policy).every((key) => KNOWN_POLICY_KEYS.has(key))
    ? policy
    : { ...policy, automation: 'off', relocation: 'off' }
}

export function sessionHostSyncShardIndex(id: string, entry: unknown, count: number): number {
  const session = (entry as { s?: unknown } | null)?.s
  const key =
    typeof session === 'string' && /^[0-9a-f]{24}$/.test(session)
      ? session
      : sessionHostDigest(id).slice('sha256:'.length)
  return Number.parseInt(key.slice(0, 4), 16) % count
}

/** This computer's entries in the fewest documents that each fit omnios' bound, never fewer than before. */
export function layoutSessionHostSyncDocs(doc: SessionHostSyncDoc, from = 1): SessionHostSyncDoc[] {
  for (let count = Math.max(1, from); ; count *= 2) {
    const docs = Array.from({ length: count }, (): SessionHostSyncDoc => ({
      entries: {},
      opaque: {}
    }))
    for (const [id, entry] of Object.entries(doc.entries)) {
      docs[sessionHostSyncShardIndex(id, entry, count)]!.entries[id] = entry
    }
    for (const [id, entry] of Object.entries(doc.opaque)) {
      docs[sessionHostSyncShardIndex(id, entry, count)]!.opaque[id] = entry
    }
    const fits = docs.every(
      (part) => accountSyncValueSize(sessionHostSyncDocValue(part)) <= ACCOUNT_SYNC_VALUE_MAX_BYTES
    )
    if (fits || count >= SESSION_HOST_SYNC_MAX_DOCS) {
      return docs
    }
  }
}
