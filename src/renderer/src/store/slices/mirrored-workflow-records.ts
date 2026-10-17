import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RuntimeSessionWorkflowRecord } from '../../../../shared/session-workflow-records'

/**
 * One paired controller's workflow conversations in one workspace, as this receiver last
 * reconciled them from the controller's whole set (session counts, step 9).
 */
export type MirroredWorkflowBucket = {
  environmentId: string
  worktreeId: string
  records: RuntimeSessionWorkflowRecord[]
  /** The controller stopped sending sets (downgraded): kept and listed, but can't be verified. */
  unverified?: true
  /** Restored from the durable snapshot (session parity F24): listed "as of", never retires. */
  stale?: true
  /** With `stale`: when this receiver last had the controller's records live. */
  asOf?: number
}

export type MirroredWorkflowRecordsSlice = {
  /**
   * Owner-qualified (environment, workspace) buckets, keyed by mirroredWorkflowBucketKey.
   * Receiver-only AppState, never a WorkspaceSessionState field: the controller republishes them on
   * every reconnect, and main keeps a durable snapshot beside it (session-host/ledgers, F24).
   */
  mirroredWorkflowRecordsByOwner: Record<string, MirroredWorkflowBucket>
}

export function mirroredWorkflowBucketKey(environmentId: string, worktreeId: string): string {
  return JSON.stringify([environmentId, worktreeId])
}

export const createMirroredWorkflowRecordsSlice: StateCreator<
  AppState,
  [],
  [],
  MirroredWorkflowRecordsSlice
> = () => ({ mirroredWorkflowRecordsByOwner: {} })
