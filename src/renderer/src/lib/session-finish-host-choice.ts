import type { SessionChain } from '../../../shared/session-chain-types'
import type { SidebarSession } from './sidebar-sessions'
import { outcomeOwnerKey } from './session-outcome-owner'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFinishAction } from './session-folders'

/** Whether this row is the source of the chain, on the same execution owner. */
export function sessionOwnsOutcomeChain(session: SidebarSession, chain: SessionChain): boolean {
  if (chain.sourceRowKey !== session.rowKey) {
    return false
  }
  try {
    return outcomeOwnerKey(chain) === outcomeOwnerKey(session)
  } catch {
    return false
  }
}

/**
 * The finish the HOST recorded for this row, mirrored for this device. The device's copy only ever
 * stands in for the same choice: where the two disagree the host wins, so a stale local "Close"
 * can never close a session whose host record says Save, keep, or nothing at all.
 */
export function hostSessionFinishChoice(
  session: SidebarSession,
  chain: SessionChain,
  current?: SessionFinishAction
): SessionFinishAction | undefined {
  const set = chain.outcomeSet
  if (!set?.sessionFinish || !sessionOwnsOutcomeChain(session, chain)) {
    return undefined
  }
  const executionOwnerKey = outcomeOwnerKey(chain)
  if (current?.chainId === chain.id && current.executionOwnerKey === executionOwnerKey) {
    const seen = current.revision ?? 0
    // A snapshot older than what this device already mirrored says nothing new.
    if (
      seen > set.revision ||
      (seen === set.revision && current.action === set.sessionFinish.action)
    ) {
      return current
    }
  }
  return {
    action: set.sessionFinish.action,
    // The Done block's "Save to …" is committed on the host, so the host's folder wins over
    // whatever this device last showed; without one, the device's choice stands.
    folderId: set.sessionFinish.folderId ?? current?.folderId ?? SAVED_SESSIONS_FOLDER_ID,
    chainId: chain.id,
    executionOwnerKey,
    revision: set.revision,
    applied: false
  }
}

export function sessionFinishOwnerMatches(
  chain: SessionChain,
  expected: SessionFinishAction
): boolean {
  if (!expected.executionOwnerKey) {
    return true
  }
  try {
    return outcomeOwnerKey(chain) === expected.executionOwnerKey
  } catch {
    return false
  }
}
