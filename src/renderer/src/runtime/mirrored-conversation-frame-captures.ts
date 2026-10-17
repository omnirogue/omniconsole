// F9 (session parity, step 7): a tab frame from an owner that publishes its conversation ledger
// retires no hibernation record by itself. Its records follow the ledger's decision on the
// workspace instead, taken against the rows the frame keeps; owners without a ledger keep the
// frame-driven cleanup of A4 (#1082/#1083) byte for byte.

import type { AppState } from '@/store/types'
import {
  mirroredConversationBucketKey,
  ownerPublishesMirroredConversationLedger
} from '@/store/slices/mirrored-conversation-ledger'
import { isSessionFrameLogEnabled, recordSessionFrameLog } from './session-frame-log'
import { findOwnerOmittedConversationRecordPaneKeys } from './web-session-mirror-sleeping-records'

export type FrameRecordReconciliation = {
  copyTabIds: ReadonlySet<string>
  mirrorTabIds: ReadonlySet<string>
  conversationPaneKeys: ReadonlySet<string>
}

type LedgerFrameState = Partial<
  Pick<
    AppState,
    | 'sleepingAgentSessionsByPaneKey'
    | 'mirroredConversationLedgerByOwner'
    | 'mirroredConversationOwnersByEnvironment'
  >
>

const NONE: ReadonlySet<string> = new Set()

/**
 * What one frame's record cleanup retires: the legacy copy and mirror-pane records for an owner
 * without a ledger; for a ledger owner nothing of those, only the captures its ledger retires
 * (omitted from a live window-complete workspace, or tombstoned while it is reachable).
 */
export function ledgerAwareFrameRecordReconciliation(
  state: LedgerFrameState,
  frame: {
    environmentId: string
    worktreeId: string
    catalogOwnerEnvironmentId: string | null
    keptTabIds: ReadonlySet<string>
  },
  legacy: { copyTabIds: ReadonlySet<string>; mirrorTabIds: ReadonlySet<string> }
): FrameRecordReconciliation {
  const owner = state.mirroredConversationOwnersByEnvironment?.[frame.environmentId]
  if (!owner || !ownerPublishesMirroredConversationLedger(owner)) {
    return { ...legacy, conversationPaneKeys: NONE }
  }
  const bucket =
    state.mirroredConversationLedgerByOwner?.[
      mirroredConversationBucketKey(frame.environmentId, frame.worktreeId)
    ]
  const { omitted, tombstoned } = findOwnerOmittedConversationRecordPaneKeys(
    state.sleepingAgentSessionsByPaneKey,
    bucket,
    { ...frame, removals: owner.state === 'ready' ? owner.removals : [] }
  )
  if (isSessionFrameLogEnabled() && omitted.length + tombstoned.length > 0) {
    recordSessionFrameLog({
      kind: 'receiver.ledger',
      environmentId: frame.environmentId,
      source: 'frame',
      decision: 'retract-capture',
      worktreeId: frame.worktreeId,
      generation: bucket?.generation ?? owner.generation,
      revision: bucket?.revision ?? owner.revision,
      ...(omitted.length > 0 ? { omitted } : {}),
      ...(tombstoned.length > 0 ? { tombstoned } : {})
    })
  }
  return {
    copyTabIds: NONE,
    mirrorTabIds: NONE,
    conversationPaneKeys: new Set([...omitted, ...tombstoned])
  }
}
