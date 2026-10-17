import {
  waitLaterKeyForCard,
  waitLaterKeyForMessage,
  waitLaterKeyForThread
} from '@/lib/wait-later'
import type { WorkRow, WorkViews } from '../../../../../shared/backoffice-work-views'

/**
 * Every wait-later key a row's controls can write: its message, its thread and its card.
 * A row that carries both a card and an attached thread shows both sets of controls, so
 * ⏳ on either puts the row away; a workflow stage answers to its card's key, so putting
 * the card away puts its decisions away too.
 */
export function workRowWaitKeys(row: WorkRow): string[] {
  const keys: string[] = []
  if (row.message) {
    keys.push(waitLaterKeyForMessage(row.message.id))
  }
  if (row.thread) {
    keys.push(waitLaterKeyForThread(row.thread.id))
  }
  if (row.taskId) {
    keys.push(waitLaterKeyForCard(row.taskId))
  }
  return keys
}

export function isWorkRowWaiting(row: WorkRow, waiting: ReadonlySet<string>): boolean {
  return waiting.size > 0 && workRowWaitKeys(row).some((key) => waiting.has(key))
}

/** A row the person asked to wait on leaves Needs You (rows and count) until its time; All keeps it. */
export function withoutWaitingThreads(views: WorkViews, waiting: ReadonlySet<string>): WorkViews {
  if (waiting.size === 0) {
    return views
  }
  const needsYou = views.needsYou.filter((row) => !isWorkRowWaiting(row, waiting))
  if (needsYou.length === views.needsYou.length) {
    return views
  }
  return { ...views, needsYou, counts: { ...views.counts, needsYou: needsYou.length } }
}
