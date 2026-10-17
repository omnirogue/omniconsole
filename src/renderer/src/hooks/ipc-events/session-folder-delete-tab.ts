import {
  closeSessionTabForBulk,
  deleteKeepsPtyIds,
  isSessionTabWorking
} from '@/components/sidebar/session-folders/session-bulk-delete'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { localWorkflowTabStatus } from '@/lib/local-workflow-tab-status'
import { retractRecordOnlyMirrorRows } from '@/lib/record-only-mirror-row-retraction'
import { useAppStore } from '@/store'
import type { SessionFolderCliSession } from '@/lib/session-folder-cli-apply'
import { stewardCloseRefusal } from '@/lib/session-steward-close-check'
import type {
  SessionFolderMutationResult,
  SessionFolderOp
} from '../../../../shared/session-folder-cli'
import type { OrganizationRelayedChange } from '../../../../shared/session-organization-change'

/** Why shorter than the close's own 15s: the CLI's request must answer inside its own timeout. */
const CLOSE_WAIT_MS = 5_000

/**
 * The sidebar asks "Stop and delete?" before deleting a conversation whose agent is working;
 * a command cannot be asked, so it must say so with --force.
 */
export function refuseWorkingDelete(session: SessionFolderCliSession, force: boolean): void {
  if (!force && session.tabId && isSessionTabWorking(session.tabId)) {
    throw new Error(
      `“${session.label}” is still working. Deleting it stops the agent (its history can be reopened from Recently closed); pass --force to stop and delete it.`
    )
  }
  const workflow = !force && session.tabId ? activeWorkflowStatus(session.tabId) : null
  if (workflow) {
    throw new Error(
      `“${session.label}” is a workflow that is ${workflow === 'running' ? 'still running' : 'waiting on the person'}. Deleting it closes its tab; pass --force to delete it anyway.`
    )
  }
}

/** A workflow tab's run that is running or waits on the person; main cannot see either. */
function activeWorkflowStatus(tabId: string): 'running' | 'needs-you' | null {
  const state = useAppStore.getState()
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((entry) => entry.id === tabId)
  if (!tab?.localWorkflow) {
    return null
  }
  const status = localWorkflowTabStatus(
    tab.localWorkflow,
    state.localWorkflowStatusByTabId[tabId],
    state.buildReview.pipelinesById,
    state.buildReview.pipelinesListed,
    state.localWorkflowHydrationByTabId[tabId]
  )
  return status === 'running' || status === 'needs-you' ? status : null
}

/** Every refusal before a delete: a working agent without --force, and a steward close. */
export function refuseDelete(
  session: SessionFolderCliSession,
  op: Extract<SessionFolderOp, { kind: 'deleteSession' }>,
  change: OrganizationRelayedChange | undefined,
  dryRun: boolean
): void {
  refuseWorkingDelete(session, op.force === true)
  // Why last and synchronous: main judged it blank; a look or keystroke since then keeps it.
  const refusal = dryRun ? null : stewardCloseRefusal(change, op)
  if (refusal) {
    throw new Error(refusal)
  }
}

/**
 * What a delete does past its sidebar mark: a tab closes as its own ✕ closes it, and a record-only
 * row of another computer's pane — only this computer's record of it — drops that record (A4): no
 * RPC, no process. Returns the toast's undo for the record, if one was dropped.
 */
export async function finishSessionDelete(
  op: SessionFolderOp,
  session: SessionFolderCliSession | null,
  result: SessionFolderMutationResult
): Promise<(() => void) | undefined> {
  if (op.kind !== 'deleteSession' || !session) {
    return undefined
  }
  if (session.tabId) {
    await closeDeletedSessionTab(result, session.tabId, {
      purge: op.purge === true,
      unverified: op.unverified === true
    })
    return undefined
  }
  return op.paneKey ? retractRecordOnlyMirrorRows([op.paneKey]) : undefined
}

/** Closes a deleted conversation's tab and folds how that went into the window's answer. */
export async function closeDeletedSessionTab(
  result: SessionFolderMutationResult,
  tabId: string,
  options: { purge?: boolean; unverified?: boolean } = {}
): Promise<void> {
  const closed = await closeDeletedTab(tabId, options)
  result.summary = [result.summary, closed.summary].join(' ')
  result.tabClose = closed.outcome
}

/**
 * Closes a deleted conversation's tab the way the sidebar's Delete does — history kept,
 * reopenable from Recently closed — and says how that went: whether its terminal ended, stays
 * because another tab here still shows it, or was never touched (`unverified`: the person let
 * go of a row this computer cannot verify, which removes the row only).
 */
export async function closeDeletedTab(
  tabId: string,
  options: { purge?: boolean; unverified?: boolean } = {}
): Promise<{ outcome: 'closed' | 'declined' | 'unverified'; summary: string }> {
  // Why before the close: the plan reads the tab rows the close removes.
  const keepsTerminal = !options.unverified && deleteKeepsPtyIds(tabId).length > 0
  const outcome = await Promise.race([
    closeSessionTabForBulk(tabId, {
      captureRecentlyClosed: options.purge !== true,
      endProcess: options.unverified !== true
    }),
    new Promise<'unverified'>((resolve) => setTimeout(() => resolve('unverified'), CLOSE_WAIT_MS))
  ])
  if (outcome === 'closed' && options.purge) {
    return {
      outcome,
      summary: translate(
        'conversations.cliFolders.deletedTabPurged',
        'Its tab closed for good; it is not in Recently closed.'
      )
    }
  }
  if (outcome === 'closed' && options.unverified) {
    return {
      outcome,
      summary: translate(
        'conversations.cliFolders.deletedTabClosedUnverified',
        'Its tab closed; no terminal was ended, since this computer could not verify it. Reopen it from Recently closed.'
      )
    }
  }
  if (outcome === 'closed' && keepsTerminal) {
    return {
      outcome,
      summary: translate(
        'conversations.cliFolders.deletedTabClosedTerminalKept',
        'Its tab closed; its terminal stays open because another tab here still shows it. Reopen it from Recently closed.'
      )
    }
  }
  if (outcome === 'closed') {
    return {
      outcome,
      summary: translate(
        'conversations.cliFolders.deletedTabClosed',
        'Its tab closed; reopen it from Recently closed.'
      )
    }
  }
  return {
    outcome,
    summary:
      outcome === 'declined'
        ? translate(
            'conversations.cliFolders.deletedTabKept',
            'Its tab did not close, so it stays in the list.'
          )
        : translate(
            'conversations.cliFolders.deletedTabClosing',
            'Its tab has not reported closing yet.'
          )
  }
}

/** A review page's Reject: no Undo, since the transcript and worktree go right after the row. */
export function showPurgedToast(summary: string): void {
  toast(summary, {
    description: translate(
      'conversations.cliFolders.rejectPurgeDescription',
      'Deleted because its review page was rejected. Its history is not kept.'
    )
  })
}
