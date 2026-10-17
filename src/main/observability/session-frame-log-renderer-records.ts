// Admission for renderer-sent session frame log records (session-count fix, step 0). The renderer is
// in the threat model: it may only add receiver/renderer records, never owner or log records, never
// this process's ordering keys, and never one oversized line.

import {
  SESSION_FRAME_LOG_MAX_BATCH,
  SESSION_FRAME_LOG_MAX_RECORD_BYTES
} from '../../shared/session-frame-log'
import { isSessionFrameLogEnabled, recordSessionFrameLog } from './session-frame-log'

const RENDERER_KIND = /^(receiver|renderer)\.[a-z0-9.-]{1,64}$/
/** Why stripped: main stamps these; `side`/`sender` say which process and window sent a record. */
const MAIN_OWNED_FIELDS = new Set(['t', 'seq', 'pid', 'side', 'sender', 'rendererT'])

function admit(
  record: unknown
): { kind: string; fields: Record<string, unknown>; rendererT?: number } | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null
  }
  const { kind, t } = record as { kind?: unknown; t?: unknown }
  if (typeof kind !== 'string' || !RENDERER_KIND.test(kind)) {
    return null
  }
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!MAIN_OWNED_FIELDS.has(key)) {
      fields[key] = value
    }
  }
  return { kind, fields, ...(typeof t === 'number' ? { rendererT: t } : {}) }
}

function boundedFields(kind: string, fields: Record<string, unknown>): Record<string, unknown> {
  let serialized: string
  try {
    serialized = JSON.stringify(fields)
  } catch {
    return { kind, truncated: true, reason: 'unserializable' }
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes <= SESSION_FRAME_LOG_MAX_RECORD_BYTES) {
    return fields
  }
  return {
    kind,
    truncated: true,
    bytes,
    // Why a prefix: the identity fields come first in every record, so the head stays useful.
    head: serialized.slice(0, SESSION_FRAME_LOG_MAX_RECORD_BYTES / 4)
  }
}

/** Appends one renderer batch; returns how many records were admitted. Never throws. */
export function appendRendererSessionFrameRecords(records: unknown, senderId?: number): number {
  if (!isSessionFrameLogEnabled() || !Array.isArray(records)) {
    return 0
  }
  let appended = 0
  let rejected = 0
  for (const record of records.slice(0, SESSION_FRAME_LOG_MAX_BATCH)) {
    const admitted = admit(record)
    if (!admitted) {
      rejected += 1
      continue
    }
    recordSessionFrameLog({
      ...boundedFields(admitted.kind, admitted.fields),
      kind: admitted.kind,
      side: 'renderer',
      ...(admitted.rendererT !== undefined ? { rendererT: admitted.rendererT } : {}),
      ...(senderId !== undefined ? { sender: senderId } : {})
    })
    appended += 1
  }
  const dropped = Math.max(0, records.length - SESSION_FRAME_LOG_MAX_BATCH)
  if (rejected > 0 || dropped > 0) {
    recordSessionFrameLog({ kind: 'main.renderer-batch-refused', rejected, dropped })
  }
  return appended
}
