import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import {
  runSessionBulkAction,
  type SessionBulkOutcome
} from '@/components/sidebar/session-folders/session-bulk-outcome'
import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../../shared/conversation-source'
import {
  nextStepRiskOf,
  safeNextSteps,
  type NextStepSuggestion,
  type NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import { decideNextStepSet } from './next-steps-client'

export type NextStepsInboxRow = {
  key: string
  label: string
  set: NextStepSuggestionSet
  conversation: ConversationSource
  /** The tab that shows the conversation, when a sidebar row still owns it. */
  tabId: string | null
  /** No sidebar row owns the conversation: shown, never run or expanded. */
  missing: boolean
}

/**
 * One row per conversation with a pending set, newest first, named as the sidebar names it. Rows
 * are keyed by the full conversation row key (workspace and pane), as the pending poll keys them.
 */
export function nextStepsInboxRows(
  pending: ReadonlyMap<string, NextStepSuggestionSet>,
  sessions: readonly SidebarSession[]
): NextStepsInboxRow[] {
  const byKey = new Map<string, SidebarSession>()
  for (const session of sessions) {
    const source = conversationSourceForSession(session)
    if (source) {
      byKey.set(conversationSourceRowKey(source), session)
    }
  }
  const rows: NextStepsInboxRow[] = []
  for (const [key, set] of pending) {
    if (!set.conversation || set.status !== 'pending' || !set.suggestions.length) {
      continue
    }
    const session = byKey.get(key)
    rows.push({
      key,
      label: !session
        ? translate('nextStepsInbox.sessionNotFound', 'Session not found')
        : session.label?.trim() ||
          translate('nextStepsInbox.untitledSession', 'Untitled conversation'),
      set,
      conversation: set.conversation,
      tabId: session?.tabId ?? null,
      missing: !session
    })
  }
  return rows.toSorted((left, right) => right.set.createdAt - left.set.createdAt)
}

/** "Run all safe" for one set: the host's safe steps, re-checked against the risk floor here. */
export function inboxSafeNextSteps(set: NextStepSuggestionSet): NextStepSuggestion[] {
  return safeNextSteps(set).filter(
    (suggestion) =>
      nextStepRiskOf(`${suggestion.title} ${suggestion.prompt} ${suggestion.why ?? ''}`) === 'safe'
  )
}

export type NextStepsInboxDeps = { decide: typeof decideNextStepSet }

export const LIVE_INBOX_DEPS: NextStepsInboxDeps = { decide: decideNextStepSet }

// The host's own refusal words for a set that was answered or retired meanwhile.
const NO_LONGER_PENDING = /no longer (?:available|be answered)|can no longer|already taken/i

export function refusalOutcome(error: unknown): { ok: false; message: string } {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    message: NO_LONGER_PENDING.test(detail)
      ? translate('nextStepsInbox.stale', 'Skipped: no longer pending. {{reason}}', {
          reason: detail
        }).trim()
      : detail
  }
}

/** Dismisses every listed set; a set answered meanwhile is reported, not silently skipped. */
export async function dismissAllInInbox(
  rows: readonly NextStepsInboxRow[],
  deps: NextStepsInboxDeps = LIVE_INBOX_DEPS
): Promise<SessionBulkOutcome[]> {
  return runSessionBulkAction(rows, async (row) => {
    try {
      await deps.decide(row.set.id, { action: 'dismiss' })
      return { ok: true }
    } catch (error) {
      return refusalOutcome(error)
    }
  })
}

/** "N sessions", in the catalog's `_one` / `_other` plural pattern. */
export function formatInboxSessionCount(count: number): string {
  return count === 1
    ? translate('nextStepsInbox.sessions_one', '{{count}} session', { count })
    : translate('nextStepsInbox.sessions_other', '{{count}} sessions', { count })
}

export function formatRunAllSafe(count: number): string {
  return count === 1
    ? translate('nextStepsInbox.runAllSafe_one', 'Run all safe in {{count}} session', { count })
    : translate('nextStepsInbox.runAllSafe_other', 'Run all safe in {{count}} sessions', {
        count
      })
}
