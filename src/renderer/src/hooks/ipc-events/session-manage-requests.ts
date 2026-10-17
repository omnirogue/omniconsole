import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { conversationViewKey } from '@/lib/conversation-view'
import { applyRelayedOrganizationChange } from '@/lib/session-organization-relayed-change'
import { undoOrganizationChangeWithNotice } from '@/lib/session-organization-undo-notice'
import type { OrganizationRelayedChange } from '../../../../shared/session-organization-change'
import type { SessionWorkflowAnchorRef } from '../../../../shared/session-workflow-anchor'
import { toast } from 'sonner'
import { fileTransferredSession, readTransferFileReceipt } from './session-manage-file'
import { archiveTransferredSessions } from './session-manage-archive'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { findTabSleepingAgentRecord } from '@/components/native-chat/native-chat-tab-sleeping-record'
import { launchSleepingAgentSession } from '@/lib/sleeping-agent-session-launch'
import {
  isMirrorRecordRelaunchRefused,
  mirrorRecordRelaunchRefusalReason
} from '@/lib/mirror-record-relaunch-guard'
import {
  buildSessionManageSidebarRows,
  matchManagedSession
} from '@/lib/session-manage-sidebar-rows'
import { conversationOrganizationFor } from '@/lib/session-manage-conversation-organization'
import { ledgerOnlyRowRefusal } from '@/lib/mirrored-conversation-row-actions'
import { buildPaneSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import { PROMPT_QUEUE_RPC, type PromptQueue } from '../../../../shared/prompt-queue-types'
import type {
  SessionManageConversationOrganization,
  SessionManageProjectRowsReply,
  SessionManageNoticeUndo,
  SessionManageRenameReply,
  SessionManageRendererRequest,
  SessionManageResumeReply
} from '../../../../shared/session-manage-relay'
import { useAppStore } from '../../store'
import { showSidebarSession } from './session-show-request'
import { scheduleWhenFinished } from '@/lib/session-when-finished'
import { forgetSleptPane, sleptPaneParkedNow } from './slept-pane-parked-now'
import { readRenderedSidebarCounts } from '@/components/sidebar/session-folders/rendered-sidebar-counts'
import {
  buildSessionParityPopulation,
  sessionOwnerLedgerStates
} from '@/lib/session-parity-population'
import { answerOmniosQuestion } from './omnios-question-answer'

const TOAST_DURATION_MS = 12_000

function description(): string {
  return translate(
    'conversations.cliFolders.toastDescription',
    'Changed by a command run in a terminal session.'
  )
}

/** The pane row a request names: a named pane exactly (never a sibling), else the tab's own row. */
export function findManagedSession(
  target: { paneKey?: string; tabId?: string; workflow?: SessionWorkflowAnchorRef },
  options: { tabOnly?: boolean } = {}
): SidebarSession | null {
  return matchManagedSession(buildPaneSessions(useAppStore.getState()), target, options)
}

function requireSession(target: { paneKey?: string; tabId?: string }): SidebarSession {
  const session = findManagedSession(target)
  if (!session) {
    throw new Error(
      `No conversation in the sidebar matches ${target.paneKey ? `pane ${target.paneKey}` : `tab ${target.tabId}`}.`
    )
  }
  return session
}

/** The name the person set on the tab, or null when the tab shows its generated name. */
function customTitleOf(tabId: string): string | null {
  const state = useAppStore.getState()
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((entry) => entry.id === tabId)
    if (tab) {
      return tab.customTitle ?? null
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    const tab = tabs.find((entry) => entry.id === tabId || entry.entityId === tabId)
    if (tab) {
      return tab.customLabel ?? null
    }
  }
  return null
}

function rename(request: {
  paneKey?: string
  tabId?: string
  title: string
  change?: OrganizationRelayedChange
}): SessionManageRenameReply {
  const session = requireSession(request)
  // Why (E1): a row the owner's ledger created is named on its owner; a pending-handle mirror
  // tab under it is not a tab of this window's to rename.
  const refusal = ledgerOnlyRowRefusal(session)
  if (refusal) {
    throw new Error(refusal)
  }
  const tabId = session.tabId
  if (!tabId) {
    throw new Error(`“${session.label}” has no open tab, so there is no name to change.`)
  }
  const previous = customTitleOf(tabId)
  const title = request.title.trim()
  const { change } = request
  // Same action as the sidebar's own rename: the tab title, which the sidebar row shows first.
  const organization = change
    ? applyRelayedOrganizationChange(
        {
          ...change,
          kind: 'title',
          targets: [
            {
              sessionKey: conversationViewKey(session),
              tabId,
              ...(session.paneKey ? { paneKey: session.paneKey } : {})
            }
          ],
          value: title
        },
        { folders: useSessionFolders, view: useSessionSidebarView },
        () => null
      )
    : undefined
  if (!organization) {
    // Why: an older main sends no change, so there is nothing to record against.
    useAppStore.getState().setTabCustomTitle(tabId, title, { origin: 'unknown' })
  }
  const summary = translate('conversations.cliSessions.renamed', 'Renamed “{{from}}” to “{{to}}”', {
    from: session.label,
    to: title
  })
  toast(summary, {
    description: description(),
    duration: TOAST_DURATION_MS,
    action: {
      label: translate('conversations.cliFolders.undo', 'Undo'),
      onClick: () => {
        if (organization) {
          void undoOrganizationChangeWithNotice(organization.opId, 'notice')
        } else {
          useAppStore.getState().setTabCustomTitle(tabId, previous, { origin: 'unknown' })
        }
      }
    }
  })
  return { summary, before: session.label, after: title, ...(organization ? { organization } : {}) }
}

/** A review wake after a restart: only a pane hibernation slept, whose PTY the daemon says is gone. */
async function resumeSleptPane(request: {
  paneKey?: string
  tabId?: string
  launchTabId?: string
}): Promise<SessionManageResumeReply> {
  const session = requireSession(request)
  // Nothing else runs between this check and resume().
  if (!session.paneKey || !(await sleptPaneParkedNow(session.paneKey))) {
    throw new Error(
      `“${session.label}” is not a pane put to sleep whose terminal is gone, so it was not restarted.`
    )
  }
  return resume(request)
}

/** The "Resume conversation" path: the same provider session reopened in a new tab. */
function resume(request: {
  paneKey?: string
  tabId?: string
  launchTabId?: string
}): SessionManageResumeReply {
  const session = requireSession(request)
  const records = useAppStore.getState().sleepingAgentSessionsByPaneKey ?? {}
  const record =
    (session.paneKey ? records[session.paneKey] : undefined) ??
    (session.tabId ? findTabSleepingAgentRecord(records, session.tabId, session.paneKey) : null)
  if (!record) {
    throw new Error(
      `“${session.label}” exited without a resumable checkpoint. Start it again from its tab.`
    )
  }

  const state = useAppStore.getState()
  if (isMirrorRecordRelaunchRefused(record, state)) {
    throw new Error(
      mirrorRecordRelaunchRefusalReason(record, state) === 'unverified'
        ? `“${session.label}” runs on another computer that has not confirmed it yet (it may be restarting), so it is not restarted from here. Try again once that computer lists it.`
        : `“${session.label}” ran on another computer, which no longer lists it, so it is not restarted from here. Resume it on that computer.`
    )
  }
  let tabId: string | null = null
  const launched = launchSleepingAgentSession(record, {
    ...(request.launchTabId ? { tabId: request.launchTabId } : {}),
    suppressNavigation: true,
    onSessionLaunched: (launchedTabId) => {
      tabId = launchedTabId
    }
  })
  if (!launched) {
    throw new Error(`“${session.label}” could not be resumed.`)
  }
  const summary = translate(
    'conversations.cliSessions.resumed',
    'Resumed “{{session}}”: the same conversation, in a new tab',
    { session: session.label }
  )
  toast(summary, { description: description(), duration: TOAST_DURATION_MS })
  return { summary, tabId }
}

async function dequeue(undo: SessionManageNoticeUndo): Promise<void> {
  const { queue } = await callRuntimeRpc<{ queue: PromptQueue }>(
    { kind: 'local' },
    PROMPT_QUEUE_RPC.list,
    {
      source: undo.source
    }
  )
  const entry = queue.entries.find((candidate) => candidate.id === undo.entryId)
  if (entry?.state !== 'queued') {
    toast.error(
      translate('conversations.cliSessions.undoSent', 'Already sent, so it cannot be taken back.')
    )
    return
  }
  await callRuntimeRpc({ kind: 'local' }, PROMPT_QUEUE_RPC.remove, {
    source: undo.source,
    entryId: undo.entryId
  })
}

function notice(request: { summary: string; undo?: SessionManageNoticeUndo }): { shown: true } {
  const { undo } = request
  toast(request.summary, {
    description: description(),
    duration: TOAST_DURATION_MS,
    ...(undo
      ? {
          action: {
            label: translate('conversations.cliFolders.undo', 'Undo'),
            onClick: () => {
              void dequeue(undo).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : String(error))
              )
            }
          }
        }
      : {})
  })
  return { shown: true }
}

function conversationOrganization(target: {
  hostId: string
  sessionId: string
}): SessionManageConversationOrganization {
  if (!useSessionSidebarView.getState().loaded) {
    useSessionSidebarView.getState().load()
  }
  const { view, archived } = useSessionSidebarView.getState()
  return conversationOrganizationFor(view, archived, target)
}

export function answerSessionManageRequest(request: SessionManageRendererRequest): unknown {
  switch (request.kind) {
    case 'fileTransferredSession':
      return fileTransferredSession(request)
    case 'readTransferFileReceipt':
      return readTransferFileReceipt(request.operationId)
    case 'readTransferArchiveReceipt':
      return useSessionSidebarView.getState().readTransferArchiveReceipt(request.operationId)
    case 'archiveSessions':
      return archiveTransferredSessions(request)
    case 'listSessions': {
      // Why: before the session restores, the list is empty, and a delete must not read that as gone.
      if (request.requireReady && !useAppStore.getState().workspaceSessionReady) {
        throw new Error('The OmniConsole window is still restoring its sessions.')
      }
      const rows = buildSessionManageSidebarRows(useAppStore.getState(), Date.now(), {
        projectFolderId: request.projectFolderId
      })
      return request.projectFolderId
        ? ({
            projectFolderId: request.projectFolderId,
            rows
          } satisfies SessionManageProjectRowsReply)
        : rows
    }
    case 'renameSession':
      return rename(request)
    case 'resumeSession':
      return request.onlySleptPane ? resumeSleptPane(request) : resume(request)
    case 'paneParkedBySleep':
      return sleptPaneParkedNow(request.paneKey)
    case 'forgetSleptPane':
      return forgetSleptPane(request.paneKey)
    case 'conversationOrganization':
      return conversationOrganization(request)
    case 'notice':
      return notice(request)
    case 'showSession':
      return showSidebarSession(requireSession(request), request)
    case 'scheduleFinish':
      // Same "When finished: End" a person can pick; the finish tick closes it once verified.
      scheduleWhenFinished(requireSession(request), { action: request.action })
      return { scheduled: true }
    case 'readSidebarCounts':
      return readRenderedSidebarCounts()
    case 'readParityPopulation':
      // Why null while restoring: a half-restored list would read as missing conversations.
      return useAppStore.getState().workspaceSessionReady
        ? buildSessionParityPopulation(useAppStore.getState())
        : null
    case 'readOwnerLedgers':
      return sessionOwnerLedgerStates(useAppStore.getState())
    case 'answerOmniosQuestion':
      return answerOmniosQuestion(request)
  }
}
