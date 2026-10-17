import { z } from 'zod'
import {
  SESSION_BATCH_REQUEST_EXCERPT_LIMIT,
  type SessionBatchFolderOrigin,
  type SessionBatchSessionOrigin
} from '../../../shared/session-batch-origin'

/** Enough history for months of batches without crowding this device's storage. */
export const SESSION_BATCH_ORIGIN_FOLDER_LIMIT = 500
export const SESSION_BATCH_ORIGIN_SESSION_LIMIT = 3000

export type SessionBatchSessionRecord = SessionBatchSessionOrigin & { at: number }

export type SessionBatchOrigins = {
  version: 1
  folders: Record<string, SessionBatchFolderOrigin>
  sessions: Record<string, SessionBatchSessionRecord>
}

const folderOrigin = z.object({
  folderId: z.string().min(1),
  batchId: z.string().min(1),
  requestExcerpt: z.string().max(SESSION_BATCH_REQUEST_EXCERPT_LIMIT),
  createdAt: z.number().finite(),
  source: z.literal('session-prep')
})

const sessionOrigin = z.object({
  batchId: z.string().min(1),
  index: z.number().int().nonnegative(),
  independent: z.literal(true).optional(),
  at: z.number().finite()
})

export function emptySessionBatchOrigins(): SessionBatchOrigins {
  return { version: 1, folders: {}, sessions: {} }
}

// Why entry by entry: one damaged record must not cost every other folder its origin.
function validEntries<T>(value: unknown, schema: z.ZodType<T>): Record<string, T> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const entries: [string, T][] = []
  for (const [key, entry] of Object.entries(value)) {
    const parsed = schema.safeParse(entry)
    if (parsed.success) {
      entries.push([key, parsed.data])
    }
  }
  return Object.fromEntries(entries)
}

export function parseSessionBatchOrigins(value: unknown): SessionBatchOrigins {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) {
    return emptySessionBatchOrigins()
  }
  const raw = value as { folders?: unknown; sessions?: unknown }
  const folders = validEntries(raw.folders, folderOrigin)
  return {
    version: 1,
    folders: Object.fromEntries(
      Object.entries(folders).filter(([key, origin]) => key === origin.folderId)
    ),
    sessions: validEntries(raw.sessions, sessionOrigin)
  }
}

function newest<T>(
  records: Record<string, T>,
  limit: number,
  at: (record: T) => number
): Record<string, T> {
  const entries = Object.entries(records)
  if (entries.length <= limit) {
    return records
  }
  return Object.fromEntries(entries.sort(([, a], [, b]) => at(b) - at(a)).slice(0, limit))
}

export function recordSessionBatchFolder(
  data: SessionBatchOrigins,
  origin: SessionBatchFolderOrigin
): SessionBatchOrigins {
  return {
    ...data,
    folders: newest(
      { ...data.folders, [origin.folderId]: origin },
      SESSION_BATCH_ORIGIN_FOLDER_LIMIT,
      (entry) => entry.createdAt
    )
  }
}

export function recordSessionBatchSession(
  data: SessionBatchOrigins,
  sessionKey: string,
  origin: SessionBatchSessionOrigin,
  at: number
): SessionBatchOrigins {
  return {
    ...data,
    sessions: newest(
      {
        ...data.sessions,
        [sessionKey]: {
          batchId: origin.batchId,
          index: origin.index,
          ...(origin.independent ? { independent: true as const } : {}),
          at
        }
      },
      SESSION_BATCH_ORIGIN_SESSION_LIMIT,
      (entry) => entry.at
    )
  }
}

/** A session's origin follows it to its durable key; one already recorded there wins. */
export function migrateSessionBatchOrigin(
  data: SessionBatchOrigins,
  from: string,
  to: string
): SessionBatchOrigins {
  if (from === to || !Object.hasOwn(data.sessions, from)) {
    return data
  }
  const sessions = { ...data.sessions }
  sessions[to] ??= sessions[from]!
  delete sessions[from]
  return { ...data, sessions }
}
