/**
 * The host's own rows while no window answers (session parity, step 3, addendum B3): the rows the
 * window last listed (rows.json), every one kept — unknown means keep — and only rebound when the
 * store no longer holds its pane but holds its conversation elsewhere, plus every conversation the
 * main inventory holds that they lack, built from the same persisted LOCAL partition the
 * main-authored ledger publishes. So a cold headless start with a persisted record
 * and no rows.json still lists it to adoption, `sessionHost.observe`, `resolveOwnerTarget` and
 * headless resume. Left out, as the sidebar leaves them out: passive completed records and deleted
 * tab-less conversations. A built row says only what main knows; the window's fields it cannot
 * know (Done clocks, project threads, templates) stay absent, which every reader takes as unknown.
 */

import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { SAVED_SESSIONS_REF_ID } from '../../shared/session-folder-ref'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { HostOrganizationValuesReader } from '../session-organization/host-organization-instance'
import type {
  MainConversationInventory,
  MainInventoryConversation
} from './main-conversation-inventory'

/** The window's own row keys (sidebar-sessions.ts): a tab pane's, else a record's. */
function rowKeyOf({ worktreeId, paneKey, tabId }: MainInventoryConversation): string {
  return JSON.stringify(
    tabId ? [LOCAL_EXECUTION_HOST_ID, worktreeId, paneKey] : [LOCAL_EXECUTION_HOST_ID, paneKey]
  )
}

const paneOf = (worktreeId: string, paneKey: string) => JSON.stringify([worktreeId, paneKey])

function builtRow(
  conversation: MainInventoryConversation,
  values: Pick<HostOrganizationValuesReader, 'entry'>
): SessionManageSidebarRow {
  const held = values.entry(conversation.viewKey)?.values ?? {}
  const placement = held.placement ?? null
  const { worktreeId, paneKey, tabId } = conversation
  return {
    rowKey: rowKeyOf(conversation),
    viewKey: conversation.viewKey,
    paneKey,
    tabId,
    kind: 'terminal',
    structuredSessionId: null,
    worktreeId,
    hostId: LOCAL_EXECUTION_HOST_ID,
    hostUnavailable: false,
    title: conversation.title,
    agent: conversation.agent,
    workspace: worktreeId,
    worktreePath: null,
    repoId: null,
    repoLabel: null,
    branch: null,
    workspaceKind: 'unknown',
    folderId: placement,
    folder: null,
    saved: placement === SAVED_SESSIONS_REF_ID,
    archived: held.archived === true,
    archivedByHand: false,
    pinned: false,
    launchPending: false,
    resumable: conversation.resumable,
    shellForeground: false,
    folded: false,
    providerSessionId: conversation.providerSession?.id ?? null,
    hidden: held.hidden === true
  }
}

/**
 * A remembered row whose pane the store no longer holds, rebound to where its conversation is now
 * (a headless resume opened it in a new tab: addendum B3); every other row exactly as listed.
 */
function rebound(
  row: SessionManageSidebarRow,
  byViewKey: ReadonlyMap<string, MainInventoryConversation>,
  heldPanes: ReadonlySet<string>
): SessionManageSidebarRow {
  const current = byViewKey.get(row.viewKey)
  return current &&
    row.paneKey &&
    current.worktreeId === row.worktreeId &&
    current.paneKey !== row.paneKey &&
    !heldPanes.has(paneOf(row.worktreeId, row.paneKey))
    ? {
        ...row,
        rowKey: rowKeyOf(current),
        paneKey: current.paneKey,
        tabId: current.tabId,
        resumable: current.resumable
      }
    : row
}

/** The remembered rows, then a row for each listed conversation they lack. */
export function withMainInventoryRows(
  remembered: readonly SessionManageSidebarRow[],
  inventory: MainConversationInventory | null,
  values: Pick<HostOrganizationValuesReader, 'entry'>
): SessionManageSidebarRow[] {
  if (!inventory) {
    return [...remembered]
  }
  const byViewKey = new Map(inventory.conversations.map((entry) => [entry.viewKey, entry]))
  const heldPanes = new Set(
    inventory.conversations.map((entry) => paneOf(entry.worktreeId, entry.paneKey))
  )
  const kept = remembered.map((row) => rebound(row, byViewKey, heldPanes))
  const keptPanes = new Set(
    kept.flatMap((row) => (row.paneKey ? [paneOf(row.worktreeId, row.paneKey)] : []))
  )
  const keptKeys = new Set(kept.map((row) => row.viewKey))
  const built = inventory.conversations.filter(
    (conversation) =>
      conversation.listed &&
      !keptKeys.has(conversation.viewKey) &&
      !keptPanes.has(paneOf(conversation.worktreeId, conversation.paneKey)) &&
      !(conversation.surface === 'record' && values.entry(conversation.viewKey)?.values.deleted)
  )
  return [...kept, ...built.map((conversation) => builtRow(conversation, values))]
}
