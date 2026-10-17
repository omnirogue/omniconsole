import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore, type AppState } from '@/store'
import { mirroredConversationBucketKey } from '@/store/slices/mirrored-conversation-ledger'
import { ledgerRecordsSpeakingForCapture } from '@/runtime/mirrored-conversation-captures'
import {
  isMirrorPaneSleepingRecord,
  mirrorRecordOwnerEnvironmentId,
  sleepingRecordTabId
} from '@/runtime/web-session-mirror-sleeping-records'
import {
  getCatalogRuntimeOwnerEnvironmentId,
  getSessionInventoryWorkspaceProvenance
} from './session-inventory-workspace-provenance'

type LaunchConfigs = AppState['agentLaunchConfigByPaneKey']

/** Its owner's conversation ledger lists it (session parity, step 7): it is not only a copy here. */
function ownerLedgerListsRecord(
  state: AppState,
  record: SleepingAgentSessionRecord,
  tabId: string
): boolean {
  const owner = mirrorRecordOwnerEnvironmentId(
    tabId,
    getCatalogRuntimeOwnerEnvironmentId(state, record.worktreeId)
  )
  const bucket = owner
    ? state.mirroredConversationLedgerByOwner?.[
        mirroredConversationBucketKey(owner, record.worktreeId)
      ]
    : undefined
  // Why the speaking records (F14): a sibling Pi/Prime transcript listed under the same session
  // does not make this capture the owner's; its own digest, or an ambiguous match, does.
  return Boolean(
    bucket && ledgerRecordsSpeakingForCapture(bucket.records, record).some((entry) => entry.listed)
  )
}

const NO_UNDO = (): void => {}

/** Puts back the records (and the launch configs dropped with them) still missing from the store. */
function restoreRetractedRecords(
  retracted: readonly SleepingAgentSessionRecord[],
  launchConfigs: LaunchConfigs
): void {
  useAppStore.setState((current) => {
    const missing = retracted.filter(
      (record) => !current.sleepingAgentSessionsByPaneKey?.[record.paneKey]
    )
    if (missing.length === 0) {
      return current
    }
    const restoredConfigs = Object.fromEntries(
      missing.flatMap((record) =>
        launchConfigs[record.paneKey] && !current.agentLaunchConfigByPaneKey?.[record.paneKey]
          ? [[record.paneKey, launchConfigs[record.paneKey]!]]
          : []
      )
    )
    return {
      sleepingAgentSessionsByPaneKey: {
        ...current.sleepingAgentSessionsByPaneKey,
        ...Object.fromEntries(missing.map((record) => [record.paneKey, record]))
      },
      ...(Object.keys(restoredConfigs).length > 0
        ? {
            agentLaunchConfigByPaneKey: {
              ...current.agentLaunchConfigByPaneKey,
              ...restoredConfigs
            }
          }
        : {})
    }
  })
}

/**
 * Deleting a record-only row of another computer's pane retracts the record behind it (A4).
 *
 * Such a row is nothing but this computer's saved copy of a pane another computer ran; deleting
 * it only marked the row deleted, so the record lived on (and the next resume sweep could reopen
 * it). The delete drops exactly those records (and their launch configs): no RPC is sent, no
 * process is touched, and the owner's own records and transcripts stay. A record under a
 * workspace a paired computer owns counts whatever its pane id (a plain-UUID capture, C4); one its
 * owner's ledger lists is not a copy only and stays. Returns the undo, which puts both back.
 * Never throws: the delete it rides on has already been saved, and its toast and Undo must still
 * appear. The ledger's own capture retirement retracts through here too (session parity, step 7).
 */
export function retractRecordOnlyMirrorRows(paneKeys: Iterable<string>): () => void {
  try {
    const state = useAppStore.getState()
    // Why: a store without records (tests, early startup) has nothing to retract.
    const records = state.sleepingAgentSessionsByPaneKey ?? {}
    const retracted: SleepingAgentSessionRecord[] = []
    for (const paneKey of new Set(paneKeys)) {
      const record = records[paneKey]
      const tabId = record ? sleepingRecordTabId(record) : null
      if (
        record &&
        tabId !== null &&
        isMirrorPaneSleepingRecord(
          record,
          getSessionInventoryWorkspaceProvenance(state, record.worktreeId)
        ) &&
        // Why: with its tab here the row is the tab's, and closing the tab owns the record.
        !(state.tabsByWorktree?.[record.worktreeId] ?? []).some((tab) => tab.id === tabId) &&
        !ownerLedgerListsRecord(state, record, tabId)
      ) {
        retracted.push(record)
      }
    }
    if (retracted.length === 0) {
      return NO_UNDO
    }
    const launchConfigs: LaunchConfigs = { ...state.agentLaunchConfigByPaneKey }
    state.clearSleepingAgentSessionsByPaneKey(retracted.map((record) => record.paneKey))
    return () => {
      try {
        restoreRetractedRecords(retracted, launchConfigs)
      } catch (error) {
        console.warn('[record-only-mirror-row-retraction] undo failed:', error)
      }
    }
  } catch (error) {
    console.warn('[record-only-mirror-row-retraction] retraction failed:', error)
    return NO_UNDO
  }
}
