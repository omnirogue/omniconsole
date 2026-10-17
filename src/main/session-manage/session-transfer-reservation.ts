import { SessionManageRefusal } from './session-manage-refusal'
import type { TransferSession } from './session-manage-transfer-contract'

const reserved = new Set<string>()

/** Shared source/target conversations cannot participate in two transfers at once. */
export function sessionTransferReservation(): {
  acquire(sessions: readonly TransferSession[]): void
  release(): void
} {
  const owned = new Set<string>()
  return {
    acquire(sessions) {
      const keys = sessions.flatMap(({ row }) => [
        JSON.stringify(['conversation', row.worktreeId, row.viewKey]),
        JSON.stringify(['pane', row.worktreeId, row.paneKey ?? row.tabId])
      ])
      if (keys.some((key) => reserved.has(key) && !owned.has(key))) {
        throw new SessionManageRefusal(
          'Another handoff or consolidation already owns a source or target. Nothing was changed by this step.'
        )
      }
      for (const key of keys) {
        reserved.add(key)
        owned.add(key)
      }
    },
    release() {
      for (const key of owned) {
        reserved.delete(key)
      }
    }
  }
}
