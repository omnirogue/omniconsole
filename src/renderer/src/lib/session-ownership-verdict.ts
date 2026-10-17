import { translate } from '@/i18n/i18n'
import { classifySessionInventoryTab } from '../../../shared/session-inventory-ownership'
import type { SessionOwnershipUnverifiedReason } from '../../../shared/session-manage-relay'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { parseWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { resolveMirroredTerminalRowOwner } from '@/runtime/web-session-mirror-owner'
import { getSessionInventoryWorkspaceProvenance } from './session-inventory-workspace-provenance'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import {
  isRecordOnlyMirrorRow,
  mirrorRowLacksOwnerConversationEvidence,
  type MirrorRowEvidenceState
} from './mirror-row-owner-evidence'

export type SessionOwnershipVerdictState = WorktreeRuntimeOwnerState &
  MirrorRowEvidenceState & {
    tabsByWorktree?: Readonly<Record<string, readonly TerminalTab[] | undefined>>
    unifiedTabsByWorktree?: Readonly<Record<string, readonly Tab[] | undefined>>
    terminalLayoutsByTabId?: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
    ptyIdsByTabId?: Readonly<Record<string, readonly string[] | undefined>>
  }

/**
 * Why a row cannot be verified as owned by any one computer, or null. These are the rows the
 * publisher quarantines (conflicting or unresolved provenance) and the legacy mirror aliases the
 * receiver will not route actions for: they stay listed and are never hidden, only labelled.
 */
export function getSessionOwnershipUnverifiedReason(
  state: SessionOwnershipVerdictState,
  session: Parameters<typeof isRecordOnlyMirrorRow>[0] & { worktreeId: string }
): SessionOwnershipUnverifiedReason | null {
  // Why (step 6): its owner's ledger lists or holds it (G1): the owner's own word that the
  // conversation is its and still there — neither a doubtful owner nor an unconfirmed absence.
  if (session.mirroredConversation) {
    return null
  }
  if (!session.tabId) {
    // Why (A4): a record of another computer's pane with no tab here is a conversation its owner
    // stopped listing without this computer seeing it close.
    return isRecordOnlyMirrorRow(session) ? 'absence-unverified' : null
  }
  if (session.kind === 'structured') {
    const chat = state.unifiedTabsByWorktree?.[session.worktreeId]?.find(
      (row) => row.id === session.tabId
    )
    return chat?.mirrorAbsenceUnverified ? 'absence-unverified' : null
  }
  if (session.kind !== 'terminal') {
    return null
  }
  const tab = state.tabsByWorktree?.[session.worktreeId]?.find((row) => row.id === session.tabId)
  if (!tab) {
    return null
  }
  const ownership = getTerminalOwnershipUnverifiedReason(state, session.worktreeId, tab)
  // Why: which computer owns the row is the more specific doubt, so it is named first.
  return (
    ownership ??
    (tab.mirrorAbsenceUnverified || mirrorRowLacksOwnerConversationEvidence(state, session, tab)
      ? 'absence-unverified'
      : null)
  )
}

function getTerminalOwnershipUnverifiedReason(
  state: SessionOwnershipVerdictState,
  worktreeId: string,
  tab: TerminalTab
): SessionOwnershipUnverifiedReason | null {
  const unifiedTab = state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (row) => row.contentType === 'terminal' && row.entityId === tab.id
  )
  const layout = state.terminalLayoutsByTabId?.[tab.id]
  if (parseWebTerminalSurfaceTabId(tab.id)) {
    const owner = resolveMirroredTerminalRowOwner(tab, {
      layout,
      ptyIds: state.ptyIdsByTabId?.[tab.id],
      unifiedTab
    })
    return owner.kind === 'ambiguous' ? 'conflicting-provenance' : null
  }
  const verdict = classifySessionInventoryTab(
    getSessionInventoryWorkspaceProvenance(state, worktreeId),
    {
      tabId: tab.id,
      executionHostId: unifiedTab?.executionHostId,
      ptyIds: [tab.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})]
    }
  )
  return verdict.kind === 'unverified' ? verdict.reason : null
}

/** The row's one-line caption for a conversation whose owning computer cannot be verified. */
export function sessionOwnershipUnverifiedCaption(
  reason?: SessionOwnershipUnverifiedReason
): string {
  return reason === 'absence-unverified'
    ? translate('conversations.absenceUnverified', "Can't verify this is still open")
    : translate('conversations.ownershipUnverified', "Can't verify which computer owns this")
}

/** The details note: why, and what this computer does about it. */
export function sessionOwnershipUnverifiedNote(reason: SessionOwnershipUnverifiedReason): string {
  if (reason === 'absence-unverified') {
    return translate(
      'conversations.absenceUnverifiedNote',
      'Its computer stopped listing it without confirming it closed. Kept here and not restarted until that computer can check.'
    )
  }
  return reason === 'unresolved-workspace'
    ? translate(
        'conversations.ownershipUnverifiedWorkspace',
        'Its workspace is recorded on more than one computer. Kept here; not shared with paired computers.'
      )
    : translate(
        'conversations.ownershipUnverifiedConflict',
        'Its saved details name more than one computer. Kept here; not shared or sent to a guessed computer.'
      )
}
