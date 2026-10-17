// Owner half of step 3's ordering contract: one inventory generation per runtime incarnation and
// one revision counter shared by every writer of the stored session-tab snapshots and by removal
// tombstones. The stored-snapshot map reports each write here, so renderer sync, headless
// hydration, browser reconciliation, listAll repair and PTY publication all draw from the same
// counter without each having to remember to.

import { randomUUID } from 'node:crypto'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { SessionTabsInventoryOrder } from '../../shared/session-tabs-inventory-order'
import { FrameLoggedMobileSessionTabsMap } from './session-frame-log-owner'
import type { MobileSessionTabsWriteObserver } from './session-frame-log-owner'

type Snapshot = RuntimeMobileSessionTabsSnapshot

export class SessionInventoryLedger implements MobileSessionTabsWriteObserver {
  private revision = 0
  // Why per object: a frame built from a superseded snapshot must carry that snapshot's revision,
  // never the worktree's newer one, or a delayed stale frame would outrank the current one.
  private readonly revisionBySnapshot = new WeakMap<Snapshot, number>()
  private readonly revisionByWorktree = new Map<string, number>()
  // Why kept until re-added: the removal frame is stamped after the delete, from this record.
  private readonly tombstoneByWorktree = new Map<string, number>()

  // Why no clock: generations are compared only for equality (see SessionTabsInventoryOrder).
  constructor(readonly generation: string = randomUUID()) {}

  onSet(worktree: string, previous: Snapshot | undefined, next: Snapshot): number | null {
    if (previous === next) {
      return null
    }
    const revision = ++this.revision
    this.revisionBySnapshot.set(next, revision)
    this.revisionByWorktree.set(worktree, revision)
    this.tombstoneByWorktree.delete(worktree)
    return revision
  }

  onDelete(worktree: string): number {
    const revision = ++this.revision
    this.revisionByWorktree.delete(worktree)
    this.tombstoneByWorktree.set(worktree, revision)
    return revision
  }

  /** The order of a stored (or once-stored) snapshot; null if this ledger never saw it. */
  orderFor(snapshot: Snapshot): SessionTabsInventoryOrder | null {
    const revision =
      this.revisionBySnapshot.get(snapshot) ?? this.revisionByWorktree.get(snapshot.worktree)
    return revision === undefined ? null : this.order(revision)
  }

  /** The order of the latest removal tombstone for a worktree, while it stays removed. */
  tombstoneOrderFor(worktree: string): SessionTabsInventoryOrder | null {
    const revision = this.tombstoneByWorktree.get(worktree)
    return revision === undefined ? null : this.order(revision)
  }

  currentRevision(): number {
    return this.revision
  }

  private order(revision: number): SessionTabsInventoryOrder {
    return { generation: this.generation, revision }
  }
}

/** The stored-snapshot map with every write stamped by `ledger` (and frame-logged when enabled). */
export function createLedgeredMobileSessionTabsMap(
  ledger: SessionInventoryLedger
): FrameLoggedMobileSessionTabsMap {
  const map = new FrameLoggedMobileSessionTabsMap()
  map.writeObserver = ledger
  return map
}
