import { toast } from 'sonner'
import { ensureSessionSidebarStoresLoaded } from './session-sidebar-stores-load'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  applySessionFolderOp,
  type AppliedSessionFolderOp,
  type SessionFolderCliSession,
  type SessionFolderCliStores
} from '@/lib/session-folder-cli-apply'
import { listSessionFolderEntries } from '@/lib/session-folder-cli-list'
import { previewSessionFolderOp } from '@/lib/session-folder-cli-preview'
import { undoRelayedFolderChange, type RelayedChangeRef } from '@/lib/session-folder-cli-toast-undo'
import { getSessionFolderId } from '@/lib/session-folders'
import {
  answerOrganizationProbe,
  applyRelayedOrganizationChange,
  beginRelayedOrganizationChange,
  type RelayedSession
} from '@/lib/session-organization-relayed-change'
import { refreshSessionOrganizationOwnership } from '@/lib/session-organization-ownership'
import { settleHostOrganization } from '@/lib/session-organization-host-settle'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  sessionFolderDisplayPath,
  SAVED_SESSIONS_LABEL
} from '../../../../shared/session-folder-ref'
import { useSessionBatchOrigins } from '@/store/session-batch-origins'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTags } from '@/store/session-tags'
import { useWaitLater } from '@/store/wait-later-store'
import type { OrganizationViewStores } from '@/lib/session-organization-view-values'
import type {
  SessionFolderListResult,
  SessionFolderOp,
  SessionFolderProbeReply,
  SessionFolderRendererRequestPayload
} from '../../../../shared/session-folder-cli'
import { organizationKindForFolderOp } from '../../../../shared/session-organization-folder-ops'
import {
  isStewardExecutor,
  SESSION_ORGANIZATION_RPC,
  type OrganizationChange,
  type OrganizationRecord,
  type OrganizationRelayedChange,
  type OrganizationRelayedOutcome
} from '../../../../shared/session-organization-change'
import type { SessionBatchOriginsSnapshot } from '../../../../shared/session-batch-origin'
import { useAppStore } from '../../store'
import { finishSessionDelete, refuseDelete, showPurgedToast } from './session-folder-delete-tab'
import { refuseOwnerPlacedMove } from './session-folder-move-refusal'
import { answerSessionManageRequest, findManagedSession } from './session-manage-requests'
import { answerOrganizeChanges } from './session-organize-request'
import { answerSessionProjectRequest, isSessionProjectRequest } from './session-project-requests'

const STORES: SessionFolderCliStores & OrganizationViewStores = {
  folders: useSessionFolders,
  view: useSessionSidebarView,
  tags: useSessionTags,
  waitLater: useWaitLater
}
const SESSION_POLL_MS = 150
const UNDO_TOAST_DURATION_MS = 12_000

type SessionOp = Extract<
  SessionFolderOp,
  { kind: 'moveSession' | 'archiveSession' | 'deleteSession' }
>

function findSession(op: SessionOp): SessionFolderCliSession | null {
  // Why the shared finder: a chat-view row is addressed by the pane key `omni session list` prints,
  // and a pane-less workflow anchor (`op.workflow`) by its controller and run, in archive and
  // delete alike; any other pane-less row only by a delete.
  const session = findManagedSession(op, { tabOnly: op.kind === 'deleteSession' })
  return session
    ? { key: conversationViewKey(session), label: session.label, tabId: session.tabId }
    : null
}

/** Where a session sits now, for the audit log's before/after. */
function sessionPlace(key: string): string {
  const { metadata } = useSessionFolders.getState()
  const folderId = getSessionFolderId(metadata, key)
  const folder = metadata.folders.find((entry) => entry.id === folderId)
  const place = folder
    ? sessionFolderDisplayPath(metadata.folders, folder)
    : folderId
      ? SAVED_SESSIONS_LABEL
      : 'unfiled'
  const archived = useSessionSidebarView.getState().archived.includes(key)
  const deleted = useSessionSidebarView.getState().view.deleted?.includes(key) === true
  return [place, archived ? 'archived' : null, deleted ? 'deleted' : null]
    .filter(Boolean)
    .join(', ')
}

/** A terminal created a moment ago is listed once its tab lands in the store; wait for it. */
async function waitForSession(op: SessionOp): Promise<SessionFolderCliSession> {
  const deadline = Date.now() + (op.kind === 'moveSession' ? (op.waitMs ?? 0) : 0)
  for (;;) {
    const session = findSession(op)
    if (session) {
      return session
    }
    if (Date.now() >= deadline) {
      throw new Error(
        op.paneKey
          ? `No conversation in the sidebar has pane ${op.paneKey}. Run this inside an OmniConsole terminal pane, or pass --pane <paneKey>.`
          : `The new terminal (tab ${op.tabId}) did not appear in the Conversations sidebar in time.`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_MS))
  }
}

const organizationRpc = <T>(method: string, params?: unknown): Promise<T> =>
  callRuntimeRpc<T>({ kind: 'local' }, method, params)

function showChangeToast(
  applied: Extract<AppliedSessionFolderOp, { ok: true }>,
  change: RelayedChangeRef | null,
  bySteward: boolean,
  onUndo?: () => void
): void {
  toast(applied.result.summary, {
    description: bySteward
      ? translate(
          'conversations.cliFolders.stewardCloseDescription',
          'Closed by the session steward because nobody had asked it anything. The Work card says whether its agent was confirmed stopped.'
        )
      : translate(
          'conversations.cliFolders.toastDescription',
          'Changed by a command run in a terminal session.'
        ),
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: translate('conversations.cliFolders.undo', 'Undo'),
      onClick: () => {
        onUndo?.()
        void undoRelayedFolderChange(applied.undo, change, STORES, { rpc: organizationRpc }).then(
          (undone) => {
            if (!undone) {
              toast.error(
                translate(
                  'conversations.cliFolders.undoConflict',
                  'Could not undo: the folders changed since. Move them back by hand.'
                )
              )
            }
          }
        )
      }
    }
  })
}

function isSessionOp(op: SessionFolderOp): op is SessionOp {
  return op.kind === 'moveSession' || op.kind === 'archiveSession' || op.kind === 'deleteSession'
}

async function mutate(
  op: SessionFolderOp,
  dryRun: boolean,
  change: OrganizationRelayedChange | undefined
): Promise<unknown> {
  const session = isSessionOp(op) ? await waitForSession(op) : null
  if (op.kind === 'deleteSession' && session) {
    refuseDelete(session, op, change, dryRun)
  }
  if (op.kind === 'moveSession') {
    refuseOwnerPlacedMove(op)
  }
  if (dryRun) {
    const preview = previewSessionFolderOp(op, STORES, session)
    if (!preview.ok) {
      throw new Error(preview.error)
    }
    return preview.result
  }
  ensureSessionSidebarStoresLoaded()
  const organization = beginRelayedOrganizationChange({
    op,
    change,
    session,
    stores: STORES,
    deps: { rpc: organizationRpc }
  })
  const before = session ? sessionPlace(session.key) : undefined
  const applied = applySessionFolderOp(op, STORES, session, change?.executor)
  if (!applied.ok) {
    throw new Error(applied.error)
  }
  if (applied.reveal.length > 0) {
    useSessionSidebarView.getState().setCollapsed(applied.reveal, false)
  }
  const restoreRecords = await finishSessionDelete(op, session, applied.result)
  const finished = organization.finish(
    session ? { ...applied.result, before, after: sessionPlace(session.key) } : applied.result
  )
  const recorded = finished.organization
  if (op.kind === 'deleteSession' && op.purge) {
    showPurgedToast(applied.result.summary)
  } else {
    showChangeToast(
      applied,
      recorded
        ? { opId: recorded.opId, kind: organizationKindForFolderOp(op), targets: recorded.targets }
        : null,
      op.kind === 'deleteSession' && !!change && isStewardExecutor(change.executor),
      restoreRecords
    )
  }
  return finished
}

function findRelayedSession(
  target: Parameters<typeof findManagedSession>[0]
): RelayedSession | null {
  // Why the target as given: a recorded workflow anchor is found by its run, never by tab alone.
  const session = findManagedSession(target)
  return session ? { key: conversationViewKey(session), tabId: session.tabId } : null
}

function probe(records: OrganizationRecord[]): SessionFolderProbeReply {
  ensureSessionSidebarStoresLoaded()
  return { answers: answerOrganizationProbe(records, STORES, findRelayedSession) }
}

function applyChange(change: OrganizationChange): OrganizationRelayedOutcome {
  ensureSessionSidebarStoresLoaded()
  return applyRelayedOrganizationChange(change, STORES, findRelayedSession)
}

function list(): SessionFolderListResult {
  if (!useSessionFolders.getState().loaded) {
    useSessionFolders.getState().load()
  }
  return {
    folders: listSessionFolderEntries(
      useSessionFolders.getState().metadata,
      useSessionSidebarView.getState().view
    )
  }
}

async function answer(payload: SessionFolderRendererRequestPayload): Promise<void> {
  try {
    const { request } = payload
    if (request.kind === 'recordBatchFolder' || request.kind === 'recordBatchSession') {
      useSessionBatchOrigins.getState().record(request)
      window.api.ui.replySessionFolders({ requestId: payload.requestId, ok: true, result: null })
      return
    }
    if (request.kind === 'listBatchOrigins') {
      const { folders, sessions } = useSessionBatchOrigins.getState().read()
      window.api.ui.replySessionFolders({
        requestId: payload.requestId,
        ok: true,
        result: { folders, sessions } satisfies SessionBatchOriginsSnapshot
      })
      return
    }
    const result =
      request.kind === 'list'
        ? list()
        : request.kind === 'mutate'
          ? await mutate(request.op, request.dryRun === true, request.change)
          : request.kind === 'probeOrganization'
            ? probe(request.records)
            : request.kind === 'applyOrganizationChange'
              ? applyChange(request.change)
              : request.kind === 'applyOrganizationChanges'
                ? await answerOrganizeChanges(request.changes, findRelayedSession)
                : isSessionProjectRequest(request)
                  ? answerSessionProjectRequest(request)
                  : await answerSessionManageRequest(request)
    window.api.ui.replySessionFolders({ requestId: payload.requestId, ok: true, result })
  } catch (error) {
    window.api.ui.replySessionFolders({
      requestId: payload.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * `omni folder …` / `omni session move` requests from the runtime. Each is answered in the order
 * received, one at a time, so a script's create-then-move sees its own folder.
 */
export function registerSessionFolderRequestIpcBridge(unsubs: (() => void)[]): void {
  // Why optional: partial preload doubles in tests and older preloads have no folder channel.
  if (typeof window.api.ui.onRequestSessionFolders !== 'function') {
    return
  }
  let queue: Promise<void> = Promise.resolve()
  unsubs.push(
    window.api.ui.onRequestSessionFolders((payload) => {
      queue = queue.then(() => answer(payload)).catch(() => {})
    })
  )
  reconcileWhenSessionsLoad(unsubs)
}

/** Main settles changes a crash interrupted by asking this bridge; tabs must be restored first. */
function reconcileWhenSessionsLoad(unsubs: (() => void)[]): void {
  const reconcile = (): void => {
    // Why refresh after: a reconciled or adopted change can make a placement an agent's own.
    void organizationRpc(SESSION_ORGANIZATION_RPC.reconcile)
      .catch(() => {})
      .then(() => settleHostOrganization())
      .then(() => refreshSessionOrganizationOwnership())
  }
  if (useAppStore.getState().workspaceSessionReady) {
    reconcile()
    return
  }
  const stop = useAppStore.subscribe((state) => {
    if (state.workspaceSessionReady) {
      stop()
      reconcile()
    }
  })
  unsubs.push(stop)
}
