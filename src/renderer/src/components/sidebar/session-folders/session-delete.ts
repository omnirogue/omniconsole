import { useCallback, useContext } from 'react'
import { toast } from 'sonner'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { deleteSessionsByPerson } from '@/lib/session-organization-person-changes'
import { retractRecordOnlyMirrorRows } from '@/lib/record-only-mirror-row-retraction'
import { refuseMirroredConversationDeletes } from '@/lib/mirrored-conversation-delete-guard'
import { closeSessionTabForBulk, isSessionTabWorking } from './session-bulk-delete'
import { findSessionAnswerWait, sessionAnswerWaitConfirmation } from './session-delete-answer-wait'
import { useAppStore } from '@/store'
import { isUnifiedTabPinned, shouldConfirmPinnedTabClose } from '@/store/pinned-tab-close-guard'

type ExtraRows = readonly { key: string; label: string }[]

/** The sessions in a batch whose agent is still working; deleting those stops them. */
export function workingSessions(sessions: readonly SidebarSession[]): SidebarSession[] {
  // Why: a paired owner's conversation is refused below, so it is never asked about here.
  return sessions.filter(
    (session) =>
      !session.mirroredConversation && session.tabId && isSessionTabWorking(session.tabId)
  )
}

/**
 * Delete conversations in one step: each open tab closes the way its own ✕ closes it (history
 * kept, reopenable from Recently closed) and the row leaves the list — archived, hidden and
 * already-closed rows included, which is what a person deleting them expects. One toast
 * reports it with Undo, which brings the rows back (a closed tab reopens from Recently closed).
 */
export async function deleteSidebarSessions(
  sessions: readonly SidebarSession[],
  extraRows: ExtraRows = [],
  confirmedWorkingTabs: ReadonlySet<string> = new Set()
): Promise<string[]> {
  // Why (session parity, step 7): a conversation a paired owner lists runs there; delete it there.
  const unique = refuseMirroredConversationDeletes([
    ...new Map(sessions.map((session) => [conversationViewKey(session), session])).values()
  ])
  if (unique.length === 0 && extraRows.length === 0) {
    return []
  }
  const tabIds = [
    ...new Set(unique.map((session) => session.tabId).filter((id): id is string => !!id))
  ]
  const outcomes = await Promise.all(
    tabIds.map((tabId) => {
      // Routine RPCs and confirmation can yield long enough for an idle tab to start work.
      if (isSessionTabWorking(tabId) && !confirmedWorkingTabs.has(tabId)) {
        return Promise.resolve('declined')
      }
      const session = unique.find((row) => row.tabId === tabId)!
      // An orphaned chat has no execution route; only its stale client tab can be removed.
      if (session.kind === 'structured' && session.unavailable && session.hostId === null) {
        const state = useAppStore.getState()
        if (!state.getKnownWorktreeById(session.worktreeId)) {
          if (
            isUnifiedTabPinned(state, session.worktreeId, tabId) &&
            shouldConfirmPinnedTabClose(state)
          ) {
            return Promise.resolve('declined')
          }
          return Promise.resolve(state.closeUnifiedTab(tabId) ? 'detached' : 'declined')
        }
      }
      return closeSessionTabForBulk(tabId)
    })
  )
  const closed = new Set(
    tabIds.filter((_, index) => ['closed', 'detached'].includes(outcomes[index]!))
  )
  const keys = [
    ...new Set([
      ...unique
        .filter((session) => !session.tabId || closed.has(session.tabId))
        .map(conversationViewKey),
      ...extraRows.map((row) => row.key)
    ])
  ]
  if (keys.length > 0 && !deleteSessionsByPerson(keys, true)) {
    toast.error(translate('conversations.deleteFailed', 'Could not save the deletion. Try again.'))
    return []
  }
  // Why: a row that is only this computer's record of another computer's pane goes with that record.
  const restoreRecords = retractRecordOnlyMirrorRows(
    unique.flatMap((session) => (!session.tabId && session.paneKey ? [session.paneKey] : []))
  )
  const kept = outcomes.filter((outcome) => !['closed', 'detached'].includes(outcome)).length
  const detached = outcomes.filter((outcome) => outcome === 'detached').length
  const message =
    keys.length === 1
      ? translate('conversations.deletedOne', 'Deleted {{name}}', {
          name:
            unique.find((session) => conversationViewKey(session) === keys[0])?.label ??
            extraRows.find((row) => row.key === keys[0])!.label
        })
      : translate('conversations.deletedMany', 'Deleted {{count}} conversations', {
          count: keys.length
        })
  const notify = kept > 0 || detached > 0 ? toast.warning : toast.success
  notify(message, {
    description:
      kept > 0
        ? translate(
            'conversations.deletedKeptOpen',
            '{{count}} tab did not close and stays in the list.',
            { count: kept }
          )
        : detached > 0
          ? translate(
              'conversations.deletedOrphanedChats',
              'Removed {{count}} unavailable chat tabs from this device. Their source hosts could not be contacted.',
              { count: detached }
            )
          : undefined,
    action:
      keys.length > 0
        ? {
            label: translate('conversations.undoDelete', 'Undo'),
            onClick: () => {
              restoreRecords()
              deleteSessionsByPerson(keys, false, { via: 'notice' })
            }
          }
        : undefined
  })
  return keys
}

/**
 * One click deletes. A question is asked only when a session in the batch still waits on the
 * person's decision or Question, or is still working (deleting stops that agent mid-task); idle,
 * finished, hidden and archived conversations go without a prompt.
 */
export function useDeleteSidebarSessions(): (
  sessions: readonly SidebarSession[],
  extraRows?: ExtraRows | (() => Promise<ExtraRows>),
  onCompleted?: (keys: readonly string[]) => void
) => Promise<boolean> {
  // Why the raw context: a row can render without the dialog provider (tests, previews); there
  // a working session is never stopped unasked — the delete is refused instead.
  const confirm = useContext(ConfirmationDialogContext)
  return useCallback(
    async (sessions, extraRows, onCompleted) => {
      const waiting = await findSessionAnswerWait(sessions)
      if (waiting && !(await confirm?.(sessionAnswerWaitConfirmation(waiting)))) {
        return false
      }
      const working = workingSessions(sessions)
      if (
        working.length > 0 &&
        !(await confirm?.({
          title: translate('conversations.deleteWorkingTitle', 'Stop and delete?', {
            count: working.length
          }),
          description: translate(
            'conversations.deleteWorkingDescription',
            '{{count}} of these is still working. Deleting stops it; its history can be reopened from Recently closed.',
            { count: working.length }
          ),
          confirmLabel: translate('conversations.deleteWorkingConfirm', 'Stop and delete'),
          confirmVariant: 'destructive'
        }))
      ) {
        return false
      }
      const rows = typeof extraRows === 'function' ? await extraRows() : extraRows
      const keys = await deleteSidebarSessions(
        sessions,
        rows,
        new Set(working.flatMap((session) => (session.tabId ? [session.tabId] : [])))
      )
      onCompleted?.(keys)
      return true
    },
    [confirm]
  )
}
