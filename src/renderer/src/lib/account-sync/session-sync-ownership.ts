import type {
  OrganizationKeyState,
  OrganizationRecord
} from '../../../../shared/session-organization-change'
import {
  isOwnSyncEcho,
  sameOwnedValue,
  type OwnershipSyncStamp
} from '../../../../shared/session-organization-ownership'
import type { OrganizationOwnershipOutbox } from '../session-organization-ownership-outbox'
import type { SessionSyncOrganization, SyncAppliedChange } from './session-sync-stamps'

export type SessionSyncOwnershipDeps = {
  mirror: {
    stateFor: (key: string) => OrganizationKeyState
    applyRecord: (record: OrganizationRecord) => void
    attachSyncStamp: (stamp: OwnershipSyncStamp) => boolean
  }
  outbox: Pick<OrganizationOwnershipOutbox, 'stamps' | 'records'>
  mintOpId?: () => string
  now?: () => Date
}

/**
 * What account sync means for ownership. A stamp this computer authored is noted on the owned
 * change it carries, in the pass that authored it; any other stamp on an owned placement takes
 * ownership back, even when the folder is the same (X → Y → X on another computer, or an older
 * app that knows nothing of ownership). Every change a pass applies is recorded as another
 * device's, so history shows it and main takes ownership back too.
 */
export function createSessionSyncOwnership(
  deps: SessionSyncOwnershipDeps
): SessionSyncOrganization {
  const mintOpId = deps.mintOpId ?? (() => crypto.randomUUID())
  const now = deps.now ?? (() => new Date())
  // Equal-value revocations since the last recorded pass, by key.
  const revoked = new Map<string, OrganizationRecord>()

  const syncRecord = (change: SyncAppliedChange): OrganizationRecord => ({
    opId: mintOpId(),
    kind: change.field === 'placement' ? 'move' : change.after === true ? 'archive' : 'unarchive',
    targets: [{ sessionKey: change.key }],
    value: change.after,
    executor: { kind: 'sync', stamp: change.stamp },
    phase: 'applied',
    ts: now().toISOString(),
    before: [change.before],
    after: [change.after],
    revision: `sync:${change.stamp}`
  })

  const noteStamp = (key: string, opId: string, stamp: number): OwnershipSyncStamp[] => {
    const noted: OwnershipSyncStamp = { key, field: 'placement', opId, stamp }
    return deps.mirror.attachSyncStamp(noted) ? [noted] : []
  }

  return {
    noteAuthoredStamps: (authored) => {
      const noted = authored.flatMap(({ field, key, value, stamp }) => {
        const owned =
          field === 'placement' ? deps.mirror.stateFor(key).ownership.placement : undefined
        return owned && owned.syncStamp === undefined && sameOwnedValue(owned.value, value)
          ? noteStamp(key, owned.opId, stamp)
          : []
      })
      deps.outbox.stamps(noted)
    },
    onIncoming: ({ field, key, value, stamp, local, ours }) => {
      // Why placement only: of the synced fields, only a session's folder carries ownership.
      const owned =
        field === 'placement' ? deps.mirror.stateFor(key).ownership.placement : undefined
      if (!owned || isOwnSyncEcho(owned, value, stamp)) {
        return
      }
      // A stamp this computer wrote for the owned value before the change was recorded here.
      if (owned.syncStamp === undefined && ours && sameOwnedValue(owned.value, value)) {
        deps.outbox.stamps(noteStamp(key, owned.opId, stamp))
        return
      }
      const record = syncRecord({ field, key, before: local, after: value, stamp })
      deps.mirror.applyRecord(record)
      revoked.set(key, record)
    },
    recordApplied: (changes) => {
      const records = changes.map((change) => {
        const held = change.field === 'placement' ? revoked.get(change.key) : undefined
        const same = held?.executor.kind === 'sync' && held.executor.stamp === change.stamp
        if (same) {
          revoked.delete(change.key)
        }
        // Why reuse: the revocation already names this stamp; the pass now knows before and after.
        const record =
          same && held
            ? { ...held, value: change.after, before: [change.before], after: [change.after] }
            : syncRecord(change)
        deps.mirror.applyRecord(record)
        return record
      })
      records.push(...revoked.values())
      revoked.clear()
      if (records.length > 0) {
        deps.outbox.records(records)
      }
    }
  }
}
