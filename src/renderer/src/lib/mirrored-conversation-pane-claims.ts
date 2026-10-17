// One owner pane shows one row (session parity, step 6). An owner's bucket can still list two
// tab-surface records naming the same pane — the owner listed the pane twice, or the receiver
// kept the old conversation's record while the workspace read incomplete (step 5 drops it only
// once the owner's message names the workspace) — and only one may take the mirror row this
// window built for that pane, or the dormant mirror tab no row was built for: the record whose
// digest matches what the pane row here claims as its conversation, else the newest. The others
// render tab-less, so no pane is drawn twice and the live row never wears an old title.

import { resolveWebTerminalSurfaceTabIdForHost } from '@/runtime/web-session-mirror-owner'
import type { MirroredConversationBucket } from '@/store/slices/mirrored-conversation-ledger'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeSessionConversationRecord } from '../../../shared/session-conversation-ledger'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/** How the rows index an owner's pane: by host, workspace, client tab id and leaf. */
export function ownerPaneIndexKey(
  hostId: string,
  worktreeId: string,
  tabId: string,
  leafId: string
): string {
  return JSON.stringify([hostId, worktreeId, tabId, leafId])
}

/** The leaf a tab record's owner pane names, '' when it names none. */
export function ownerPaneLeafId(record: Pick<RuntimeSessionConversationRecord, 'paneKey'>): string {
  return record.paneKey ? (parsePaneKey(record.paneKey)?.leafId ?? '') : ''
}

function newest(
  records: readonly RuntimeSessionConversationRecord[]
): RuntimeSessionConversationRecord {
  return records.reduce((best, record) => (record.updatedAt > best.updatedAt ? record : best))
}

/**
 * The client tab id each listed tab record of the bucket may take here, or null: the record names
 * no owner tab, or another record of the same pane takes it.
 */
export function claimOwnerPanes(
  bucket: Pick<MirroredConversationBucket, 'environmentId' | 'worktreeId' | 'records'>,
  state: Parameters<typeof resolveWebTerminalSurfaceTabIdForHost>[0],
  /** The conversation digest the row this window built for the pane claims, if it has one. */
  claimedDigest: (paneIndexKey: string) => string | null
): Map<RuntimeSessionConversationRecord, string | null> {
  const hostId = toRuntimeExecutionHostId(bucket.environmentId)
  const claims = new Map<RuntimeSessionConversationRecord, string | null>()
  const byPane = new Map<string, RuntimeSessionConversationRecord[]>()
  for (const record of bucket.records) {
    if (!record.listed) {
      continue
    }
    // F8: the owner's tab id resolved to the client id this window gives that owner's tab.
    const tabId =
      record.surface === 'tab' && record.tabId
        ? resolveWebTerminalSurfaceTabIdForHost(
            state,
            bucket.environmentId,
            bucket.worktreeId,
            record.tabId
          )
        : null
    claims.set(record, tabId)
    if (tabId) {
      const key = ownerPaneIndexKey(hostId, bucket.worktreeId, tabId, ownerPaneLeafId(record))
      byPane.set(key, [...(byPane.get(key) ?? []), record])
    }
  }
  for (const [key, records] of byPane) {
    if (records.length < 2) {
      continue
    }
    const claimed = claimedDigest(key)
    const taker =
      records.find((record) => record.conversation !== null && record.conversation === claimed) ??
      newest(records)
    for (const record of records) {
      if (record !== taker) {
        claims.set(record, null)
      }
    }
  }
  return claims
}
