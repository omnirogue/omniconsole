import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { RuntimeSessionConversationRemoval } from '../../../shared/session-conversation-ledger'
import type { SessionInventoryWorkspaceProvenance } from '../../../shared/session-inventory-ownership'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  isWebTerminalSurfaceTabId,
  parseWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import {
  isMirroredConversationBucketAuthoritative,
  type MirroredConversationBucket
} from '@/store/slices/mirrored-conversation-ledger'
import {
  captureRemovalKeys,
  isConversationCaptureOf,
  ledgerRecordsSpeakingForCapture,
  workspaceRemovalKeys
} from './mirrored-conversation-captures'
import { retractCatalogOwnedCopySleepingRecords } from './web-session-catalog-owned-rows'

/**
 * Hibernation records this computer holds for another computer's panes (session-count fix, A4).
 *
 * The periodic and quit checkpoints capture a record for every agent status in the store, the
 * mirrored ones of a paired owner's panes included. That keeps a restored mirror row's
 * conversation identity until the owner speaks after a restart, so capture stays. What it must not
 * do is outlive the pane: the sidebar lists a record with no tab as a conversation of its own, so
 * a record the owner's frames never retired kept every conversation the owner had closed in this
 * computer's count (live on 6 Oct: 42 of the Studio's 51 extra MacBook rows, captured 3-6 Oct).
 *
 * A frame that is its owner's complete membership is the owner saying which of its panes exist,
 * so it retracts the records of that owner's mirror panes it omits. Retraction only removes this
 * computer's copy: no process is stopped, and the owner's own records and transcripts stay.
 */

export type MirrorSleepingRecordFrame = {
  worktreeId: string
  environmentId: string
  /** The frame is its owner's complete membership for the workspace (step 6). */
  membershipAffirmed: boolean
  /** Client ids of the terminal rows this frame lists. */
  listedTabIds: ReadonlySet<string>
  /** Every terminal row the workspace keeps after this frame, listed or retained. */
  keptTabIds: ReadonlySet<string>
  /** Rows this frame removed as its own (their evidence or the catalog tied them to it). */
  removedTabIds: ReadonlySet<string>
  /** The paired environment the saved catalog credits with the workspace, if exactly one. */
  catalogOwnerEnvironmentId: string | null
  /** The owner left the saved list or is provably an older pairing of the frame's own host. */
  isRetiredOwner: (ownerEnvironmentId: string) => boolean
}

export function sleepingRecordTabId(record: SleepingAgentSessionRecord): string | null {
  return record.tabId ?? parsePaneKey(record.paneKey)?.tabId ?? null
}

/**
 * A record keyed by a paired owner's mirror pane (`web-terminal-…`), not a pane this computer runs.
 * Given its workspace's provenance, a record under a workspace a paired computer owns counts
 * whatever its pane id: a plain UUID the activation sweep re-keyed it onto (C4).
 */
export function isMirrorPaneSleepingRecord(
  record: SleepingAgentSessionRecord,
  workspace?: SessionInventoryWorkspaceProvenance
): boolean {
  const tabId = sleepingRecordTabId(record)
  return (
    tabId !== null &&
    !record.connectionId &&
    (isWebTerminalSurfaceTabId(tabId) || workspace?.kind === 'peer')
  )
}

/**
 * The paired environment a mirror-pane record belongs to when its row is gone: the pane id is the
 * only evidence left — an owner-qualified id names its owner, and a legacy id belongs to the
 * workspace's catalog owner. No catalog owner (or a contested one) means nobody may speak for it:
 * kept, and labelled can't verify.
 */
export function mirrorRecordOwnerEnvironmentId(
  tabId: string,
  catalogOwnerEnvironmentId: string | null
): string | null {
  return parseWebTerminalSurfaceTabId(tabId)?.environmentId ?? catalogOwnerEnvironmentId
}

function frameOwnsMirrorRecordTab(tabId: string, frame: MirrorSleepingRecordFrame): boolean {
  if (frame.removedTabIds.has(tabId)) {
    // Why: the record follows its row; the frame just proved that row was its own.
    return true
  }
  const owner = mirrorRecordOwnerEnvironmentId(tabId, frame.catalogOwnerEnvironmentId)
  return owner !== null && (owner === frame.environmentId || frame.isRetiredOwner(owner))
}

/** Tab ids of the frame owner's mirror-pane records that its complete membership omits. */
export function findOwnerOmittedMirrorRecordTabIds(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  frame: MirrorSleepingRecordFrame
): Set<string> {
  const tabIds = new Set<string>()
  if (!frame.membershipAffirmed) {
    return tabIds
  }
  for (const record of Object.values(records ?? {})) {
    const tabId = sleepingRecordTabId(record)
    if (
      record.worktreeId !== frame.worktreeId ||
      tabId === null ||
      !isMirrorPaneSleepingRecord(record) ||
      frame.listedTabIds.has(tabId) ||
      // Why: a row the workspace keeps (another owner's, or one kept unverified) keeps its record.
      frame.keptTabIds.has(tabId)
    ) {
      continue
    }
    if (frameOwnsMirrorRecordTab(tabId, frame)) {
      tabIds.add(tabId)
    }
  }
  return tabIds
}

/** What the owner's ledger speaks for in one workspace beside its bucket (session parity, step 7). */
export type ConversationCaptureEvidence = {
  environmentId: string
  worktreeId: string
  /** The paired environment the saved catalog credits with the workspace exclusively, if any. */
  catalogOwnerEnvironmentId: string | null
  /** Terminal tabs the workspace keeps: a record whose tab is here is that tab's, not a capture. */
  keptTabIds: ReadonlySet<string>
  /** The owner's tombstones, while it is reachable live (a restored snapshot removes nothing). */
  removals: readonly RuntimeSessionConversationRemoval[]
}

export type OwnerOmittedConversationRecords = {
  /** Captures a live window set with complete coverage lists nowhere, not even `listed: false`. */
  omitted: string[]
  /** Captures the owner's tombstone names (digest or pane), whatever the coverage. */
  tombstoned: string[]
}

/**
 * Pane keys of the owner's captures in one workspace that its conversation ledger retires (step 7,
 * F9/F15): any pane id form, never one its owner lists (listed evidence wins), and by omission only
 * from an authoritative bucket (live, window-authored, complete, nothing restored or unverified).
 * Incomplete, main-authored, stale or uncovered buckets retire nothing by omission.
 */
export function findOwnerOmittedConversationRecordPaneKeys(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  bucket: MirroredConversationBucket | undefined,
  evidence: ConversationCaptureEvidence
): OwnerOmittedConversationRecords {
  const found: OwnerOmittedConversationRecords = { omitted: [], tombstoned: [] }
  const authoritative = bucket !== undefined && isMirroredConversationBucketAuthoritative(bucket)
  const removalKeys = workspaceRemovalKeys(evidence.removals, evidence.worktreeId)
  if (!authoritative && removalKeys.size === 0) {
    return found
  }
  for (const record of Object.values(records ?? {})) {
    const tabId = sleepingRecordTabId(record)
    if (
      record.worktreeId !== evidence.worktreeId ||
      tabId === null ||
      evidence.keptTabIds.has(tabId) ||
      !isConversationCaptureOf(record, evidence.environmentId, evidence.catalogOwnerEnvironmentId)
    ) {
      continue
    }
    // Why the speaking records only (F14): a sibling Pi/Prime transcript listed under the same
    // session must not keep a capture whose own digest the owner tombstoned or no longer lists.
    const vouchers = bucket ? ledgerRecordsSpeakingForCapture(bucket.records, record) : []
    if (vouchers.some((voucher) => voucher.listed)) {
      continue
    }
    if (captureRemovalKeys(record).some((key) => removalKeys.has(key))) {
      found.tombstoned.push(record.paneKey)
    } else if (authoritative && vouchers.length === 0) {
      found.omitted.push(record.paneKey)
    }
  }
  return found
}

export type FrameSleepingRecordRetraction = {
  records: Record<string, SleepingAgentSessionRecord>
  /** Records of client-minted copies the catalog owner removed (#1082). */
  copyPaneKeys: string[]
  /** Records of the owner's mirror panes its complete membership omits. */
  mirrorPaneKeys: string[]
  /** Captures the owner's conversation ledger retires (step 7). */
  conversationPaneKeys: string[]
}

function retractConversationCaptures(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string,
  paneKeys: ReadonlySet<string> | undefined
): { records: Record<string, SleepingAgentSessionRecord>; retractedPaneKeys: string[] } | null {
  const retracted = [...(paneKeys ?? [])].filter((paneKey) => {
    const record = records?.[paneKey]
    return record?.worktreeId === worktreeId && !record.connectionId
  })
  if (retracted.length === 0) {
    return null
  }
  const next = { ...records }
  for (const paneKey of retracted) {
    delete next[paneKey]
  }
  return { records: next, retractedPaneKeys: retracted }
}

/** Drops every kind of record a frame reconciled, once, so a batch writes one record map. */
export function retractFrameReconciledSleepingRecords(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string,
  reconciled: {
    copyTabIds: ReadonlySet<string>
    mirrorTabIds: ReadonlySet<string>
    conversationPaneKeys?: ReadonlySet<string>
  }
): FrameSleepingRecordRetraction | null {
  const copies = retractCatalogOwnedCopySleepingRecords(records, worktreeId, reconciled.copyTabIds)
  const mirrors = retractCatalogOwnedCopySleepingRecords(
    copies?.records ?? records,
    worktreeId,
    reconciled.mirrorTabIds
  )
  const captures = retractConversationCaptures(
    mirrors?.records ?? copies?.records ?? records,
    worktreeId,
    reconciled.conversationPaneKeys
  )
  const next = captures?.records ?? mirrors?.records ?? copies?.records
  return next
    ? {
        records: next,
        copyPaneKeys: copies?.retractedPaneKeys ?? [],
        mirrorPaneKeys: mirrors?.retractedPaneKeys ?? [],
        conversationPaneKeys: captures?.retractedPaneKeys ?? []
      }
    : null
}
