import { translate } from '@/i18n/i18n'
import { mirroredConversationComputerName } from './activate-mirrored-conversation'
import { isMirroredConversationLedgerKey } from './mirrored-sidebar-conversation'
import type { SidebarSession } from './sidebar-session-types'

type LedgerRowFacts = Pick<SidebarSession, 'rowKey' | 'mirroredConversation'>

/**
 * E1/F13 (session parity, Phase 1b): whether a paired owner's conversation ledger created this row
 * — a record row, or one placed on a pending-handle mirror tab — rather than joining a mirror row
 * this window built. Its conversation runs on its owner and no owner route for it ships in 1b, so
 * the actions that would change it from here (archive, move, rename, sleep, resume, close, delete,
 * up next, bulk) are off until Phase 2. Why the key: only such a row is keyed
 * `['runtime:<env>', 'ledger', …]`; a joined row keeps its frame key and every action it had
 * (owner-routed archive, the dormant tab's Resume banner).
 */
export function isLedgerOnlyRow(session: LedgerRowFacts): boolean {
  return (
    session.mirroredConversation !== undefined && isMirroredConversationLedgerKey(session.rowKey)
  )
}

function openOnOwner(session: Pick<SidebarSession, 'hostId'>): string {
  return translate('conversations.mirroredConversationOpenOn', 'Open it on {{computer}}.', {
    computer: mirroredConversationComputerName(session)
  })
}

/** Why a ledger-only row's action is off — "Open it on <Computer>." — or null for any other row. */
export function ledgerOnlyRowRefusal(
  session: LedgerRowFacts & Pick<SidebarSession, 'hostId'>
): string | null {
  return isLedgerOnlyRow(session) ? openOnOwner(session) : null
}

/** The rows a bulk or group action may change: every row but the ledger-only ones (E1). */
export function withoutLedgerOnlyRows<T extends LedgerRowFacts>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isLedgerOnlyRow(session))
}

/**
 * E1 for filing: whether the row's paired owner places it — its ledger states a folder, explicit
 * null (unfiled) included — so the tree files it by the owner's word (sessionRowFolderId) and a
 * move recorded here could never show. Until Phase 2b routes moves to the owner, such a row is
 * not moved, dragged or unfiled here. A ledger-only row counts too. A row whose owner has not
 * said (no folder on the record, or an owner no longer live) keeps its local filing and moves.
 */
export function isOwnerPlacedRow(session: LedgerRowFacts): boolean {
  return isLedgerOnlyRow(session) || session.mirroredConversation?.folderIdByOwner !== undefined
}

/** Why a row cannot be filed here — "Open it on <Computer>." — or null when it can. */
export function ownerPlacedRowRefusal(
  session: LedgerRowFacts & Pick<SidebarSession, 'hostId'>
): string | null {
  return isOwnerPlacedRow(session) ? openOnOwner(session) : null
}

/** The rows a move may change: every row but the ones their owner places. */
export function withoutOwnerPlacedRows<T extends LedgerRowFacts>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => !isOwnerPlacedRow(session))
}
