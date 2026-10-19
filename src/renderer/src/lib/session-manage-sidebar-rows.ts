import { getSessionOwnershipUnverifiedReason } from './session-ownership-verdict'
import { sessionManageDeleteEvidence } from './mirrored-conversation-delete-guard'
import {
  recordedSessionAgentTemplate,
  resumableSessionAgentTemplate
} from './session-agent-template-record'
import {
  sessionDoneArchivePolicy,
  sessionDoneArchiveRevision,
  sessionEmptyArchiveRevision,
  sessionTabLastSeenAt
} from './session-done-archive-policy'
import { isAgentSession } from './agent-session-note'
import {
  selectAgentPaneSnapshot,
  selectAgentPaneSnapshotInputs
} from '@/components/attention/use-agent-pane-snapshot'
import type { AppState } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useWaitLater } from '@/store/wait-later-store'
import { readRoutineOwners } from '@/components/sidebar/routines/use-routine-owners'
import { isRoutineBackedSession } from './routine-backed-session'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { pairedSessionOwnerTarget } from './session-manage-owner-target'
import { SAVED_SESSIONS_LABEL, sessionFolderDisplayPath } from '../../../shared/session-folder-ref'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { conversationViewKey, isSessionRowDeleted } from './conversation-view'
import {
  sessionUnreachableBlankRevision,
  unreachableBlankPolicy
} from './session-unreachable-blank'
import { sessionArchiveKind } from './session-manage-conversation-organization'
import { getShownChains, findShownSessionChainForRow } from './session-chain-registry'
import { SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import {
  isPinned,
  isResumable,
  isShellForeground,
  workspaceFacts
} from './session-manage-row-facts'
import { sessionHostedReviewLookup } from './session-project-hosted-review'
import { sessionProjectThreads } from './session-project-threads'
import { buildSessionSidebarTreeRows } from './session-sidebar-tree-rows'
import { buildPaneSessions, type SidebarSession } from './sidebar-sessions'
import {
  matchManagedWorkflowAnchor,
  sessionManageWorkflowAnchor
} from './session-manage-workflow-anchor'
import type { SessionWorkflowAnchorRef } from '../../../shared/session-workflow-anchor'
import { isWaitingUntil } from './wait-later'
import { mirroredWorkflowOwnerArchivedKeys } from './mirrored-workflow-rows'
import { readRememberedWorkerParents } from './worker-lineage-parents'
import { paneLeafIdentity } from './session-sidebar-worker-rows'
import { classifySessionParity } from './session-parity-classification'
import { sessionParityInputs } from './session-parity-population'

/** The pane key a conversation is addressed by: its terminal pane, or its chat session's key. */
export function sessionManagePaneKey(session: SidebarSession): string | null {
  if (session.kind === 'structured') {
    const id = session.structuredSessionId
    return id ? structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id) : null
  }
  return session.paneKey
}

/**
 * The row a request names. A named pane must be that exact pane (in that tab, when a tab is named
 * too): a closed split is never replaced by another pane of its tab. Only a bare tab resolves to
 * the tab's own row.
 */
export function matchManagedSession(
  sessions: readonly SidebarSession[],
  target: { paneKey?: string; tabId?: string; workflow?: SessionWorkflowAnchorRef },
  /** Delete only: a tab id may also name a row with no pane (a tab left from an earlier run). */
  options: { tabOnly?: boolean } = {}
): SidebarSession | null {
  if (target.workflow) {
    // Why exact, in archive and delete alike: a workflow anchor has no pane; its run names it.
    return matchManagedWorkflowAnchor(sessions, { ...target, workflow: target.workflow })
  }
  if (target.paneKey) {
    return (
      sessions.find(
        (entry) =>
          sessionManagePaneKey(entry) === target.paneKey &&
          (!target.tabId || entry.tabId === target.tabId)
      ) ?? null
    )
  }
  if (!target.tabId) {
    return null
  }
  return (
    sessions.find((entry) => entry.tabId === target.tabId && sessionManagePaneKey(entry)) ??
    (options.tabOnly ? sessions.find((entry) => entry.tabId === target.tabId) : undefined) ??
    null
  )
}

/**
 * Every conversation the Conversations sidebar holds, placed as the sidebar places it: the same
 * rows and archive classification the tree builds, minus rows the person deleted. Every pane is
 * kept so each can be addressed; a second pane of one provider conversation is marked `folded`,
 * as the sidebar lists that conversation once. With `projectFolderId`, that project's threads
 * carry `projectThread`, as the project page shows them.
 */
export function buildSessionManageSidebarRows(
  state: AppState,
  now: number = Date.now(),
  options: { projectFolderId?: string } = {}
): SessionManageSidebarRow[] {
  const folders = useSessionFolders.getState()
  if (!folders.loaded) {
    folders.load()
  }
  const viewStore = useSessionSidebarView.getState()
  if (!viewStore.loaded) {
    viewStore.load()
  }
  const { metadata } = useSessionFolders.getState()
  const { view, archived } = useSessionSidebarView.getState()
  const sessions = buildPaneSessions(state, getShownChains())
  const waits = useWaitLater.getState().view.until
  const chainByRowKey = new Map(
    sessions.flatMap((session) => {
      const chain = findShownSessionChainForRow(session.rowKey)
      return chain ? [[session.rowKey, chain] as const] : []
    })
  )
  const { rows, classifications } = buildSessionSidebarTreeRows(
    {
      sessions,
      chainByRowKey,
      waitingUntilByRowKey: waits,
      metadata,
      view,
      // Why: a mirrored workflow its controller archived reads archived here too (step 9).
      archivedKeys: new Set([
        ...archived,
        ...mirroredWorkflowOwnerArchivedKeys(state.mirroredWorkflowRecordsByOwner)
      ]),
      snapshot: selectAgentPaneSnapshot(selectAgentPaneSnapshotInputs(state)),
      query: '',
      showHidden: true,
      now
    },
    now
  )
  const threads = options.projectFolderId
    ? new Map(
        sessionProjectThreads(metadata.folders, rows, options.projectFolderId, {
          classifications,
          workerParentByLeaf: readRememberedWorkerParents(),
          coordinatorSessionKey:
            metadata.projects?.[options.projectFolderId]?.coordinator?.sessionKey,
          hostedReviewOpen: sessionHostedReviewLookup(state)
        }).map((thread) => [thread.row.session.rowKey, thread])
      )
    : null
  const deleted = new Set(view.deleted ?? [])
  const hidden = new Set(view.hidden)
  const keep = new Set(view.autoArchiveKeep ?? [])
  const byId = new Map(metadata.folders.map((folder) => [folder.id, folder]))
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const key = conversationViewKey(session)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const listed = new Set<string>()
  const workerParents = readRememberedWorkerParents()
  const routineOwners = readRoutineOwners()
  // Session parity (step 8): one bucket rule for these rows and the sidebar's counts.
  const parity = sessionParityInputs(state)
  return rows
    .filter((row) => !isSessionRowDeleted(deleted, row.session))
    .map((row): SessionManageSidebarRow => {
      const { session } = row
      const viewKey = conversationViewKey(session)
      // Why the tree row's: it is filed where the sidebar files it, the owner's word first (C3).
      const { folderId } = row
      const folder = folderId ? byId.get(folderId) : undefined
      const ownerFolder = session.mirroredConversation?.folderByOwner
      const host = parseExecutionHostId(session.hostId)
      const revision = sessionDoneArchiveRevision(
        row,
        state,
        metadata,
        view,
        counts.get(viewKey) === 1
      )
      const folded = listed.has(viewKey)
      listed.add(viewKey)
      const pinned = isPinned(state, session)
      const unreachable = pinned
        ? null
        : sessionUnreachableBlankRevision(row, state, metadata, view, counts.get(viewKey) === 1)
      const thread = threads?.get(session.rowKey)
      const bucket = classifySessionParity(session, parity)
      return {
        ...bucket,
        ownerListed: bucket.bucket === 'ownerListed',
        rowKey: session.rowKey,
        viewKey,
        paneKey: sessionManagePaneKey(session),
        tabId: session.tabId,
        kind: session.kind,
        structuredSessionId: session.structuredSessionId ?? null,
        worktreeId: session.worktreeId,
        hostId: host ? host.id : null,
        ownerTarget: pairedSessionOwnerTarget(state, session),
        hostUnavailable: session.unavailable,
        ownershipUnverified: getSessionOwnershipUnverifiedReason(state, session),
        ...sessionManageDeleteEvidence(state, session),
        title: session.label,
        ...(session.labelSource ? { titleSource: session.labelSource } : {}),
        agent: session.agent,
        workspace: session.workspaceLabel,
        ...workspaceFacts(state, session.worktreeId),
        folderId,
        folder:
          folderId === SAVED_SESSIONS_FOLDER_ID
            ? SAVED_SESSIONS_LABEL
            : folder
              ? sessionFolderDisplayPath(metadata.folders, folder)
              : ownerFolder && ownerFolder.id === folderId
                ? ownerFolder.name
                : null,
        saved: folderId === SAVED_SESSIONS_FOLDER_ID || folder?.section === 'saved',
        archived: row.archived === true,
        archivedByHand: session.ownerArchive?.byHand ?? archived.includes(viewKey),
        archiveKind: sessionArchiveKind(view, archived, viewKey, session.ownerArchive),
        providerSessionId: session.providerSession?.id ?? null,
        transcriptPath: session.providerSession?.transcriptPath ?? null,
        agentTemplate: recordedSessionAgentTemplate(state, session) ?? null,
        resumeAgentTemplate: resumableSessionAgentTemplate(state, session) ?? null,
        pinned,
        // Why: a startup deferred until first reveal is an idle, resumable tab, not a launch in flight.
        launchPending: Boolean(
          session.launchPending ||
          (session.tabId &&
            state.pendingStartupByTabId?.[session.tabId] &&
            !state.pendingStartupByTabId[session.tabId]?.deferUntilRevealed)
        ),
        resumable: isResumable(state, session),
        shellForeground: isShellForeground(state, session),
        folded,
        routine: isRoutineBackedSession(session, routineOwners),
        // Why workers too: the sidebar lists every orchestration worker with the agent sessions.
        agentSession:
          isAgentSession(metadata, session) ||
          (session.paneKey !== null && workerParents.has(paneLeafIdentity(session.paneKey))),
        hidden: hidden.has(`conversation:${viewKey}`) || hidden.has(`session:${viewKey}`),
        waitingUntil: isWaitingUntil(waits[`conversation:${viewKey}`], new Date(now))
          ? waits[`conversation:${viewKey}`]!
          : null,
        autoArchiveKeep: keep.has(viewKey),
        doneArchiveRevision: revision,
        doneArchivePolicy: pinned ? null : sessionDoneArchivePolicy(view, viewKey, revision),
        emptyArchiveRevision: pinned
          ? null
          : sessionEmptyArchiveRevision(row, state, metadata, view, counts.get(viewKey) === 1),
        lastSeenAt: sessionTabLastSeenAt(session.tabId),
        // Why undefined may pass: in the window it means "still deciding"; the wire drops it.
        unreachableBlankRevision: unreachable,
        unreachableBlankPolicy: unreachableBlankPolicy(view, viewKey, unreachable),
        ...(thread
          ? { projectThread: { status: thread.status, coordinator: thread.isCoordinator } }
          : {}),
        ...(session.workflow ? { workflow: sessionManageWorkflowAnchor(session) } : {})
      }
    })
}
