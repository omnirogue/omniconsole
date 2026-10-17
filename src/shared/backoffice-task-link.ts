/**
 * omni://backoffice/task/<btk_…>, omni://backoffice/thread/<hth_…> and
 * omni://backoffice/session/<als_…> deep links (navigate-only by design: a link can SELECT
 * surfaces, never fill or run anything — any webpage can fire the scheme, and task content is
 * agent-authored). A session link opens that conversation, as a click on its sidebar row would.
 */

import { isBoardTaskId } from './board-task-id'

// Why: the same shape the handoff contract accepts; kept literal so this stays zod-free.
const HANDOFF_THREAD_ID = /^hth_[A-Za-z0-9_-]{1,128}$/
const LEDGER_ID = /^als_[a-f0-9]{24}$/

export type BackofficeLink =
  | { kind: 'task'; id: string }
  | { kind: 'thread'; id: string }
  | { kind: 'session'; id: string }

/** What the renderer is asked to open: a card, a handoff thread, or a session (main adds its pane). */
export type BackofficeOpenTarget =
  | { taskId: string }
  | { threadId: string }
  | {
      sessionLedgerId: string
      paneKey?: string
      nativeSessionId?: string
      executionHostId?: string
    }

export function parseBackofficeLink(value: string): BackofficeLink | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'omni:' && parsed.protocol !== 'orca:') {
    return null
  }
  // URL parses omni://backoffice/task/x with host 'backoffice'.
  if (parsed.hostname !== 'backoffice') {
    return null
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 2) {
    return null
  }
  const [kind, id] = segments
  if (kind === 'task' && isBoardTaskId(id)) {
    return { kind: 'task', id }
  }
  if (kind === 'thread' && HANDOFF_THREAD_ID.test(id)) {
    return { kind: 'thread', id }
  }
  if (kind === 'session' && LEDGER_ID.test(id)) {
    return { kind: 'session', id }
  }
  return null
}

export function parseBackofficeTaskId(value: string): string | null {
  const link = parseBackofficeLink(value)
  return link?.kind === 'task' ? link.id : null
}

export function backofficeOpenTarget(link: BackofficeLink): BackofficeOpenTarget {
  if (link.kind === 'session') {
    return { sessionLedgerId: link.id }
  }
  return link.kind === 'task' ? { taskId: link.id } : { threadId: link.id }
}
