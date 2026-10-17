// Receiver records for the session frame log (session-count fix, step 0): one record per paired
// session-tabs frame with the decision the sync made and why, and what an applied frame did to the
// mirrored terminal rows and agent conversations (and which environment those rows had come from).
// Observe-only; call sites check isSessionFrameLogEnabled() first.

import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { SessionTabsInventoryOrder } from '../../../shared/session-tabs-inventory-order'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { countBy, summarizeSessionTabsFrame } from '../../../shared/session-frame-log'
import { recordSessionFrameLog } from './session-frame-log'
import {
  noteReceiverOwnershipInputs,
  resetOwnershipInputsForTests
} from './session-frame-log-ownership'

export type ReceiverFrameSource =
  | 'listAll'
  | 'subscribeAll'
  | 'subscribeAll-inventory'
  | 'subscribe-active'
  | 'visibility-repair'
  | 'rpc-result'
  | 'local-structured'

export type ReceiverFrameDecision = 'applied' | 'outranked' | 'unmirrored' | 'ignored' | 'removal'

type Freshness = { publicationEpoch: string; snapshotVersion: number }

const MAX_LISTED_ROW_IDS = 50

/** A4: rows (and their hibernation records) a catalog owner reconciled without owner evidence. */
export const CATALOG_OWNED_EVIDENCE_LESS_MIRROR_REASON = 'catalog-owned-evidence-less-mirror'

/** A4: this computer's records of an owner's mirror panes that its complete membership omits. */
export const OWNER_MEMBERSHIP_OMITS_MIRROR_PANE_REASON = 'owner-membership-omits-mirror-pane'

export function logReceiverFrameDecision(args: {
  snapshot: RuntimeMobileSessionTabsResult
  environmentId: string
  source: ReceiverFrameSource | undefined
  decision: ReceiverFrameDecision
  reason: string
  prior?: Freshness
  /** Step 3: the generation/revision a negotiated frame was ordered against. */
  priorInventoryOrder?: SessionTabsInventoryOrder | null
  publishers?: Iterable<string>
}): void {
  recordSessionFrameLog({
    kind: 'receiver.frame',
    environmentId: args.environmentId,
    source: args.source ?? 'unspecified',
    decision: args.decision,
    reason: args.reason,
    frame: summarizeSessionTabsFrame(args.snapshot),
    ...(args.prior
      ? { prior: { epoch: args.prior.publicationEpoch, version: args.prior.snapshotVersion } }
      : {}),
    ...(args.priorInventoryOrder ? { priorInventoryOrder: args.priorInventoryOrder } : {}),
    // Why: two environments publishing one workspace is C1's precondition; this names them.
    ...(args.publishers ? { publishers: [...args.publishers] } : {})
  })
  noteReceiverOwnershipInputs(args.snapshot.worktree, args.environmentId)
}

export function logReceiverFrameIgnored(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  source: ReceiverFrameSource,
  reason: string
): void {
  logReceiverFrameDecision({ snapshot, environmentId, source, decision: 'ignored', reason })
}

/** A whole response dropped before any frame was decided (stale subscription, failed call). */
export function logReceiverResponseIgnored(
  environmentId: string,
  source: ReceiverFrameSource,
  reason: string,
  frameCount?: number
): void {
  recordSessionFrameLog({
    kind: 'receiver.response',
    environmentId,
    source,
    decision: 'ignored',
    reason,
    ...(frameCount !== undefined ? { frameCount } : {})
  })
}

function terminalRowEnvironment(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined
): string {
  const ptyIds = [tab.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})].filter(
    (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0
  )
  for (const ptyId of ptyIds) {
    const remote = parseRemoteRuntimePtyId(ptyId)
    if (remote) {
      return remote.environmentId ?? 'remote-unnamed'
    }
  }
  return ptyIds.length > 0 ? 'local' : 'no-pty'
}

type MovedRow = { id: string; from: string }

function terminalRowChanges(args: {
  currentTerminalTabs: readonly TerminalTab[]
  removedTerminalIds: ReadonlySet<string>
  mirroredTerminalIds: ReadonlySet<string>
  layoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot>>
}): { replaced: MovedRow[]; removed: MovedRow[] } {
  const replaced: MovedRow[] = []
  const removed: MovedRow[] = []
  for (const tab of args.currentTerminalTabs) {
    if (!args.removedTerminalIds.has(tab.id)) {
      continue
    }
    const row = { id: tab.id, from: terminalRowEnvironment(tab, args.layoutsByTabId[tab.id]) }
    if (args.mirroredTerminalIds.has(tab.id)) {
      replaced.push(row)
    } else {
      removed.push(row)
    }
  }
  return { replaced, removed }
}

function movedRowsSummary(
  rows: readonly MovedRow[],
  reasonFor: (id: string) => string | undefined = () => undefined
): Record<string, unknown> {
  const reasons = rows.flatMap((row) => reasonFor(row.id) ?? [])
  return {
    count: rows.length,
    from: countBy(rows.map((row) => row.from)),
    ids: rows.slice(0, MAX_LISTED_ROW_IDS).map((row) => row.id),
    // Why: names the rule behind a removal where one is recorded (A4's catalog-owned copies).
    ...(reasons.length > 0 ? { reasons: countBy(reasons) } : {})
  }
}

/**
 * What an applied frame did to this workspace's rows, and whose rows they were: terminal rows
 * (including those a replaced structured conversation took with it, in agent-only frames too) and
 * agent conversations, which every applied frame rebuilds for the whole workspace bucket.
 */
export function logReceiverApplyEffect(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  contentScope: 'all' | 'agent-session'
  currentTerminalTabs: readonly TerminalTab[]
  removedTerminalIds: ReadonlySet<string>
  mirroredTerminalIds: ReadonlySet<string>
  replacedConversationTerminalIds: ReadonlySet<string>
  /** Rows the frame omitted but could not prove gone, so they were kept (step 6). */
  unverifiedOmittedTerminalIds?: ReadonlySet<string>
  /** Removed rows the catalog credited to this environment while they carried no owner evidence. */
  catalogOwnedRemovedTerminalIds?: ReadonlySet<string>
  /** Hibernation records of the removed client-minted copies, which went with them. */
  retractedSleepingRecordPaneKeys?: readonly string[]
  /** This computer's records of the owner's mirror panes its complete membership omits. */
  retractedMirrorSleepingRecordPaneKeys?: readonly string[]
  layoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot>>
  currentUnifiedTabs: readonly Tab[]
  mirroredAgentTabIds: ReadonlySet<string>
}): void {
  const terminals = terminalRowChanges(args)
  const agentTabs = args.currentUnifiedTabs.filter((tab) => tab.contentType === 'agent-session')
  const agentRow = (tab: Tab): MovedRow => ({
    id: tab.entityId,
    from: tab.executionHostId ?? 'unattributed'
  })
  const replacedAgents = agentTabs.filter((tab) => args.mirroredAgentTabIds.has(tab.id))
  const removedAgents = agentTabs.filter((tab) => !args.mirroredAgentTabIds.has(tab.id))
  const crossEnvironment = [...terminals.replaced, ...terminals.removed].filter(
    (row) => row.from !== args.environmentId && row.from !== 'no-pty'
  )
  const removalReason = (id: string): string | undefined =>
    args.catalogOwnedRemovedTerminalIds?.has(id)
      ? CATALOG_OWNED_EVIDENCE_LESS_MIRROR_REASON
      : undefined
  const retractedRecords = args.retractedSleepingRecordPaneKeys ?? []
  const retractedMirrorRecords = args.retractedMirrorSleepingRecordPaneKeys ?? []
  recordSessionFrameLog({
    kind: 'receiver.apply',
    environmentId: args.environmentId,
    worktree: args.snapshot.worktree,
    epoch: args.snapshot.publicationEpoch,
    version: args.snapshot.snapshotVersion,
    contentScope: args.contentScope,
    terminalRowsBefore: args.currentTerminalTabs.length,
    terminalRowsMirrored: args.mirroredTerminalIds.size,
    replacedRows: movedRowsSummary(terminals.replaced),
    removedRows: movedRowsSummary(terminals.removed, removalReason),
    ...(retractedRecords.length > 0
      ? {
          retractedSleepingRecords: {
            reason: CATALOG_OWNED_EVIDENCE_LESS_MIRROR_REASON,
            count: retractedRecords.length,
            paneKeys: retractedRecords.slice(0, MAX_LISTED_ROW_IDS)
          }
        }
      : {}),
    ...(retractedMirrorRecords.length > 0
      ? {
          retractedMirrorSleepingRecords: {
            reason: OWNER_MEMBERSHIP_OMITS_MIRROR_PANE_REASON,
            count: retractedMirrorRecords.length,
            paneKeys: retractedMirrorRecords.slice(0, MAX_LISTED_ROW_IDS)
          }
        }
      : {}),
    replacedConversationTerminalIds: args.currentTerminalTabs
      .filter((tab) => args.replacedConversationTerminalIds.has(tab.id))
      .map((tab) => tab.id),
    ...(args.unverifiedOmittedTerminalIds && args.unverifiedOmittedTerminalIds.size > 0
      ? {
          retainedUnverifiedRows: [...args.unverifiedOmittedTerminalIds].slice(
            0,
            MAX_LISTED_ROW_IDS
          )
        }
      : {}),
    crossEnvironmentRows: crossEnvironment.length,
    ...(crossEnvironment.length > 0
      ? { crossEnvironmentRowIds: crossEnvironment.slice(0, MAX_LISTED_ROW_IDS) }
      : {}),
    agentConversations: {
      before: agentTabs.length,
      mirrored: args.mirroredAgentTabIds.size,
      replaced: movedRowsSummary(replacedAgents.map(agentRow)),
      removed: movedRowsSummary(removedAgents.map(agentRow))
    }
  })
}

export function _resetReceiverFrameLogForTests(): void {
  resetOwnershipInputsForTests()
}
