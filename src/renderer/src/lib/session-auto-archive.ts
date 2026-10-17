import {
  DONE_ARCHIVE_IDLE_REASON,
  DONE_ARCHIVE_PROVEN_REASON,
  doneArchiveDue,
  doneArchiveEvidence,
  idleArchiveReceipt,
  isIdleArchiveReceipt,
  type SessionDoneArchivePolicy
} from '../../../shared/session-done-archive'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { isUnifiedTabPinned } from '@/store/pinned-tab-close-guard'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { translate } from '@/i18n/i18n'
import { readUpNext } from '@/components/next-action/up-next-client'
import { upNextConnection } from '@/components/next-action/up-next-connection'
import {
  sessionArchiveProof,
  sessionCompletionIdentity
} from '../../../shared/session-archive-proof'
import { conversationViewKey } from './conversation-view'
import { conversationSourceForSession } from './conversation-source-for-session'
import { buildPaneSessions, type SidebarSession } from './sidebar-sessions'
import { isSessionSaved } from './session-folders'
import { findShownSessionChainForRow } from './session-chain-registry'
import { sessionOwnsOutcomeChain } from './session-finish-host-choice'
import { outcomeRuntimeTarget } from './session-outcome-owner'
import { sessionOrganizationScope } from './account-sync/session-organization-intent'
import {
  applyRecordedChange,
  autoArchiveChange,
  resumeUnarchiveChange
} from './session-organization-app-changes'
import { archiveSessionsByPerson } from './session-organization-person-changes'

const pending = new Set<string>()
const resuming = new Set<string>()

/** Brings back a resumed session once; a tick while its record is being prepared adds none. */
function resume(key: string): Promise<unknown> {
  if (resuming.has(key)) {
    return Promise.resolve()
  }
  resuming.add(key)
  return applyRecordedChange(resumeUnarchiveChange(key)).finally(() => resuming.delete(key))
}
const checkedAt = new Map<string, number>()

function protection(session: SidebarSession, requireLoaded = true): boolean {
  const key = conversationViewKey(session)
  const folders = useSessionFolders.getState()
  const state = useAppStore.getState()
  return (
    (requireLoaded && !folders.loaded) ||
    isSessionSaved(folders.metadata, key) ||
    ['save', 'me'].includes(folders.metadata.finishActions?.[key]?.action ?? '') ||
    state.getKnownWorktreeById?.(session.worktreeId, session.hostId ?? 'local')?.isPinned ===
      true ||
    Boolean(session.tabId && isUnifiedTabPinned(state, session.worktreeId, session.tabId))
  )
}

function policyOf(rowKey: string): SessionDoneArchivePolicy | null {
  return (
    buildSessionManageSidebarRows(useAppStore.getState()).find((row) => row.rowKey === rowKey)
      ?.doneArchivePolicy ?? null
  )
}

/**
 * The receipt this session would be archived with, or null. A conversation with an outcome plan
 * needs its host's whole-commitment proof; one with none (Sal, 27 Sep) is judged by its local
 * Done clock here and by its host's idle, nothing-pending reading in `archive`.
 */
function candidate(
  session: SidebarSession,
  ownerCount?: number,
  known?: SessionDoneArchivePolicy | null,
  now = Date.now()
): string | null {
  const state = useAppStore.getState()
  const view = useSessionSidebarView.getState()
  const key = conversationViewKey(session)
  const chain = findShownSessionChainForRow(session.rowKey)
  if (
    !view.loaded ||
    !view.archiveStorageReady ||
    state.workspaceSessionReady !== true ||
    !session.sessionKey ||
    !session.tabId ||
    !session.paneKey ||
    session.launchPending ||
    session.unavailable ||
    protection(session) ||
    view.archived.includes(key) ||
    view.view.deleted?.includes(key) ||
    view.view.autoArchiveKeep?.includes(key) ||
    (chain
      ? !sessionOwnsOutcomeChain(session, chain)
      : // Why local only: a remote row keeps today's rule until its host can vouch for it.
        parseExecutionHostId(session.hostId ?? 'local')?.kind !== 'local') ||
    // One provider session open in multiple panes has multiple possible owners: keep it visible.
    (ownerCount ??
      buildPaneSessions(state).filter((row) => conversationViewKey(row) === key).length) !== 1
  ) {
    return null
  }
  const status = state.agentStatusByPaneKey[session.paneKey]
  if (
    !status ||
    !['done', 'idle'].includes(status.state) ||
    status.workingMode ||
    status.failed ||
    status.interrupted
  ) {
    return null
  }
  const policy = known === undefined ? policyOf(session.rowKey) : known
  if (!policy || !doneArchiveDue(policy, now)) {
    return null
  }
  return chain ? sessionArchiveProof(chain) : idleArchiveReceipt(key, policy)
}

async function archive(
  session: SidebarSession,
  proof: string,
  scope: string,
  restore = false
): Promise<boolean> {
  const key = conversationViewKey(session)
  pending.add(key)
  try {
    const source = conversationSourceForSession(session, session.hostId ?? 'local')
    if (!source) {
      return false
    }
    const connection = upNextConnection(outcomeRuntimeTarget(session))
    const view = await readUpNext(source, connection)
    connection.assertCurrent()
    const current = buildPaneSessions(useAppStore.getState()).find(
      (row) => row.rowKey === session.rowKey && row.sessionKey === session.sessionKey
    )
    if (scope !== sessionOrganizationScope() || !current) {
      return false
    }
    if (restore) {
      const sidebar = useSessionSidebarView.getState()
      const receipt = sidebar.view.autoArchiveLog?.findLast((entry) => entry.key === key)
      if (
        sidebar.archived.includes(key) &&
        receipt?.proof === proof &&
        !receipt.restoredAt &&
        view.archiveHasWork === true
      ) {
        await resume(key)
      }
      return false
    }
    const idle = isIdleArchiveReceipt(proof)
    const hostAgrees = idle ? view.idleArchiveClear === true : view.archiveProof === proof
    if (!hostAgrees || candidate(current) !== proof) {
      return false
    }
    const policy = policyOf(current.rowKey)
    if (!policy) {
      return false
    }
    const change = autoArchiveChange(key, proof)
    change.request.reason = idle ? DONE_ARCHIVE_IDLE_REASON : DONE_ARCHIVE_PROVEN_REASON
    change.request.evidence = doneArchiveEvidence(key, policy)
    return (await applyRecordedChange(change)).ok
  } catch {
    // Offline, old host, unknown evidence or failed persistence: retain the visible session.
    return false
  } finally {
    pending.delete(key)
  }
}

/** Reuse the existing finish tick; no scheduler, AI classifier, tab close or process stop. */
export async function applyAutomaticSessionArchives(now = Date.now()): Promise<void> {
  const view = useSessionSidebarView.getState()
  if (!view.loaded) {
    return
  }
  const scope = sessionOrganizationScope()
  const sessions = buildPaneSessions(useAppStore.getState())
  const policies = new Map(
    buildSessionManageSidebarRows(useAppStore.getState(), now).map((row) => [
      row.rowKey,
      row.doneArchivePolicy
    ])
  )
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const key = conversationViewKey(session)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const selected: { session: SidebarSession; proof: string; restore?: boolean }[] = []
  for (const session of sessions) {
    const key = conversationViewKey(session)
    const receipt = view.view.autoArchiveLog?.findLast((entry) => entry.key === key)
    if (view.archived.includes(key) && receipt && !receipt.restoredAt) {
      const chain = findShownSessionChainForRow(session.rowKey)
      const status = session.paneKey
        ? useAppStore.getState().agentStatusByPaneKey[session.paneKey]
        : null
      if (
        protection(session, false) ||
        (chain && sessionCompletionIdentity(chain) !== receipt.proof) ||
        // A short non-code turn can finish between ticks without creating an outcome chain.
        (receipt.proof.startsWith('advisory:') && (status?.updatedAt ?? 0) > receipt.at) ||
        (status &&
          (status.state === 'working' || status.state === 'waiting' || status.state === 'blocked'))
      ) {
        void resume(key)
      }
    }
    if (pending.has(key) || now - (checkedAt.get(`${scope}:${key}`) ?? 0) < 30_000) {
      continue
    }
    // Why no host poll for an idle receipt: any later status report already restores it above,
    // and polling every archived tab would crowd out new candidates.
    const restore =
      view.archived.includes(key) &&
      receipt &&
      !receipt.restoredAt &&
      !isIdleArchiveReceipt(receipt.proof)
    const proof = restore
      ? receipt.proof
      : candidate(session, counts.get(key), policies.get(session.rowKey) ?? null, now)
    if (!proof || pending.size + selected.length >= 2) {
      continue
    }
    checkedAt.set(`${scope}:${key}`, now)
    selected.push({ session, proof, ...(restore ? { restore: true } : {}) })
  }
  const results = await Promise.all(
    selected.map(({ session, proof, restore }) => archive(session, proof, scope, restore))
  )
  const keys = selected
    .filter((_, index) => results[index])
    .map(({ session }) => conversationViewKey(session))
  if (!keys.length || scope !== sessionOrganizationScope()) {
    return
  }
  toast.success(
    keys.length === 1
      ? translate('conversations.autoArchivedOne', 'Archived 1 completed session')
      : translate('conversations.autoArchived', 'Archived {{count}} completed sessions', {
          count: keys.length
        }),
    {
      id: 'completed-session-archive',
      description: translate(
        'conversations.autoArchivedHistory',
        'History and tabs are kept. Unarchive keeps them visible.'
      ),
      action: {
        label: translate('conversations.autoArchiveUndo', 'Undo'),
        onClick: () => {
          if (scope === sessionOrganizationScope()) {
            archiveSessionsByPerson(keys, false, { via: 'notice' })
          }
        }
      }
    }
  )
}
