import { conversationSourceRowKey } from '../../shared/conversation-source'
import { SessionManageRefusal } from './session-manage-refusal'
import type { TransferSession } from './session-manage-transfer-contract'

/** Refreshing a pane must not silently retarget a replacement agent or provider conversation. */
export function assertSameTransferSession(before: TransferSession, after: TransferSession): void {
  const a = before.agentProcess
  const b = after.agentProcess
  if (
    before.entry.paneKey !== after.entry.paneKey ||
    before.entry.worktreeId !== after.entry.worktreeId ||
    before.entry.terminal !== after.entry.terminal ||
    before.row.viewKey !== after.row.viewKey ||
    before.row.kind !== after.row.kind ||
    before.row.structuredSessionId !== after.row.structuredSessionId ||
    !before.source ||
    !after.source ||
    conversationSourceRowKey(before.source) !== conversationSourceRowKey(after.source) ||
    (a
      ? !b ||
        a.ptyId !== b.ptyId ||
        a.pid !== b.pid ||
        a.rootPid !== b.rootPid ||
        a.startTimeMs !== b.startTimeMs ||
        a.incarnationId !== b.incarnationId
      : b != null)
  ) {
    throw new SessionManageRefusal(
      `“${before.entry.title}” changed its conversation or agent process during the transfer. Nothing was changed by this step.`
    )
  }
}

/** Creation knows the handle and pane before the agent exists; refresh must preserve both. */
export function assertCreatedTransferSession(
  created: TransferSession,
  fresh: TransferSession
): void {
  if (
    created.entry.terminal !== fresh.entry.terminal ||
    created.entry.paneKey !== fresh.entry.paneKey ||
    created.entry.tabId !== fresh.entry.tabId ||
    created.entry.worktreeId !== fresh.entry.worktreeId ||
    created.entry.agent !== fresh.entry.agent ||
    fresh.row.kind !== 'terminal' ||
    fresh.row.hostId !== created.row.hostId ||
    !fresh.source ||
    fresh.source.paneKey !== created.entry.paneKey ||
    fresh.source.worktreeId !== created.entry.worktreeId ||
    !fresh.agentProcess
  ) {
    throw new SessionManageRefusal(
      'The launched target no longer matches its reserved pane, agent and workspace.'
    )
  }
}
