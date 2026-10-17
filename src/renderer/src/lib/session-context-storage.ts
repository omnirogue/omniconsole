import {
  validateSessionContext,
  type SessionContextAttachment
} from '../../../shared/session-context-attachments'

export type SessionContextEntries = Record<string, readonly SessionContextAttachment[]>

/** A launcher entry's own settings: kept for future sessions (pinned) or one-shot; when saved. */
export type LaunchContextMeta = { pinned: boolean; savedAt?: number }
export type LaunchContextMetaMap = Record<string, LaunchContextMeta>
export type SessionContextState = { entries: SessionContextEntries; meta: LaunchContextMetaMap }

/** Keys are `[account, kind, host, identity]`; the + launcher's own context is kind `launch`. */
export function isLaunchContextKey(key: string): boolean {
  try {
    const parsed: unknown = JSON.parse(key)
    return Array.isArray(parsed) && parsed[1] === 'launch'
  } catch {
    return false
  }
}

function storedValue(value: unknown): { items: unknown[]; meta?: LaunchContextMeta } {
  if (Array.isArray(value)) {
    return { items: value }
  }
  const stored = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  if (!stored || !Array.isArray(stored.items)) {
    throw new Error('Invalid attachment list')
  }
  const { savedAt } = stored
  return {
    items: stored.items,
    meta: {
      pinned: stored.pinned === true,
      ...(typeof savedAt === 'number' && Number.isFinite(savedAt) ? { savedAt } : {})
    }
  }
}

/**
 * Reads the saved map. A value is an attachment list or, for a launcher entry, `{ items, pinned,
 * savedAt }`. Builds before one-shot launcher context wrote bare lists only; those read as not
 * pinned. An entry that does not parse is reported so the caller keeps its raw data; an unreadable
 * map throws.
 */
export function parseSessionContextEntries(
  text: string | null
): SessionContextState & { raw: Record<string, unknown>; invalidKeys: string[] } {
  const parsed: unknown = JSON.parse(text ?? '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid context data')
  }
  const raw = parsed as Record<string, unknown>
  const entries: SessionContextEntries = {}
  const meta: LaunchContextMetaMap = {}
  const invalidKeys: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    try {
      const stored = storedValue(value)
      const items = stored.items as SessionContextAttachment[]
      validateSessionContext(items)
      entries[key] = items
      if (stored.meta && isLaunchContextKey(key)) {
        meta[key] = stored.meta
      }
    } catch {
      invalidKeys.push(key)
    }
  }
  return { entries, meta, raw, invalidKeys }
}

/** The stored form of `entries`: a launcher entry with settings carries them with its items. */
export function serializeSessionContextEntries(
  entries: SessionContextEntries,
  meta: LaunchContextMetaMap
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, items]) => {
      const settings = Object.hasOwn(meta, key) ? meta[key] : undefined
      return [key, settings ? { items, ...settings } : items]
    })
  )
}

/** Saves `items` under `key`; launcher context keeps its pin, and emptied unpinned is removed. */
export function withSessionContextEntry(
  { entries, meta }: SessionContextState,
  key: string,
  items: readonly SessionContextAttachment[],
  now = Date.now()
): SessionContextState {
  const next = { ...entries, [key]: items }
  const nextMeta = { ...meta }
  if (isLaunchContextKey(key)) {
    const pinned = meta[key]?.pinned === true
    if (items.length || pinned) {
      nextMeta[key] = { pinned, savedAt: now }
    } else {
      delete next[key]
      delete nextMeta[key]
    }
  }
  return { entries: next, meta: nextMeta }
}
