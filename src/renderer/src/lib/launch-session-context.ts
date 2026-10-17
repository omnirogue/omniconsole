import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { SessionContextAttachment } from '../../../shared/session-context-attachments'
import {
  changeSessionContextEntries,
  getSessionContext,
  launchSessionContextKey,
  sessionContextMeta,
  subscribeSessionContext
} from './session-context-store'
import { isLaunchContextKey, type LaunchContextMeta } from './session-context-storage'

/**
 * Context added in the + launcher is one-shot: it rides on the next launch only and is cleared
 * from the launcher once that launch has started, unless the person keeps it for future sessions.
 * The started session holds its own copy (bindSessionContext), so clearing the launcher never
 * takes context away from it, and a failed or cancelled launch clears nothing.
 */

/** What one launch read from the launcher, so only those items are cleared once it has started. */
export type LaunchSessionContextClaim = { key: string; ids: readonly string[] }

/** Unkept launcher context saved before it became one-shot is dropped at start once this old. */
export const STALE_LAUNCH_CONTEXT_MS = 12 * 60 * 60 * 1000
const MIGRATION_KEY = 'omni.session-context.launch-one-shot.v1'

export function readLaunchSessionContext(worktreeId: string | null): {
  items: readonly SessionContextAttachment[]
  claim: LaunchSessionContextClaim | undefined
} {
  const key = launchSessionContextKey(worktreeId)
  const items = getSessionContext(key)
  return { items, claim: items.length ? { key, ids: items.map((item) => item.id) } : undefined }
}

/**
 * For launches that never clear the launcher (session prep, the CLI project launch): only what
 * the person kept for future sessions. One-shot context is left for the next + launch.
 */
export function keptLaunchSessionContext(
  worktreeId: string | null
): readonly SessionContextAttachment[] {
  const key = launchSessionContextKey(worktreeId)
  return sessionContextMeta(key)?.pinned ? getSessionContext(key) : []
}

/** After a launch has started: clear what it used from the launcher, unless the person kept it. */
export function consumeLaunchSessionContext(claim: LaunchSessionContextClaim | undefined): void {
  if (!claim?.ids.length) {
    return
  }
  const used = new Set(claim.ids)
  try {
    changeSessionContextEntries(({ entries, meta }) => {
      const items = entries[claim.key]
      if (!items || meta[claim.key]?.pinned) {
        return undefined
      }
      // Why by id: anything added while this launch was starting belongs to the next one.
      const left = items.filter((item) => !used.has(item.id))
      if (left.length === items.length) {
        return undefined
      }
      const next = { ...entries, [claim.key]: left }
      const nextMeta = { ...meta }
      if (!left.length) {
        delete next[claim.key]
        delete nextMeta[claim.key]
      }
      return { entries: next, meta: nextMeta }
    })
  } catch {
    // Why a notice, not a failure: the session already started with its own copy.
    toast.error(
      translate(
        'sessionContext.clearFailed',
        'The launcher’s session context could not be cleared. Remove it under Session context before starting another session.'
      )
    )
  }
}

export function useLaunchSessionContextPinned(key: string): boolean {
  return useSyncExternalStore(
    subscribeSessionContext,
    () => sessionContextMeta(key)?.pinned === true
  )
}

/** Keeps the launcher's context for every future session here, or makes it one-shot again. */
export function setLaunchSessionContextPinned(key: string, pinned: boolean): void {
  changeSessionContextEntries(({ entries, meta }) => {
    const next = { ...entries }
    const nextMeta = { ...meta }
    if (pinned || next[key]?.length) {
      next[key] ??= []
      nextMeta[key] = { pinned, savedAt: Date.now() }
    } else {
      delete next[key]
      delete nextMeta[key]
    }
    return { entries: next, meta: nextMeta }
  })
}

function savedAt(
  items: readonly SessionContextAttachment[],
  settings: LaunchContextMeta | undefined
): number | undefined {
  if (settings?.savedAt !== undefined) {
    return settings.savedAt
  }
  const captured = items.flatMap((item) => (item.capturedAt === undefined ? [] : [item.capturedAt]))
  return captured.length ? Math.max(...captured) : undefined
}

/**
 * Once, at app start: launcher context saved before it became one-shot was attached to every new
 * session. Drop such entries the person did not keep once older than 12 hours, by their save time
 * or newest snapshot; one with no time on it predates this build, so it counts as old. Kept
 * entries and session or tab keys are untouched. Unreadable storage is left alone and retried.
 */
export function migrateLaunchSessionContext(now = Date.now()): void {
  try {
    if (localStorage.getItem(MIGRATION_KEY)) {
      return
    }
    changeSessionContextEntries(({ entries, meta }) => {
      const stale = Object.keys(entries).filter((key) => {
        if (!isLaunchContextKey(key) || meta[key]?.pinned) {
          return false
        }
        const at = savedAt(entries[key] ?? [], meta[key])
        return at === undefined || now - at > STALE_LAUNCH_CONTEXT_MS
      })
      if (!stale.length) {
        return undefined
      }
      const next = { ...entries }
      const nextMeta = { ...meta }
      for (const key of stale) {
        delete next[key]
        delete nextMeta[key]
      }
      return { entries: next, meta: nextMeta }
    })
    localStorage.setItem(MIGRATION_KEY, String(now))
  } catch {
    // Retried at the next start; the saved data is kept as it is.
  }
}
