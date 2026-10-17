import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'
import { isPairedOwnerConversation } from './paired-owner-execution'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'

/** Claim keys of every other sleeping session in the worktree, so only the target pane wakes. */
export function otherSleepingClaimKeys(
  records: Readonly<Record<string, SleepingAgentSessionRecord>>,
  worktreeId: string,
  paneKey: string
): Set<string> | null {
  const target = records[paneKey]
  if (!target || target.worktreeId !== worktreeId) {
    return null
  }
  const targetClaimKey = getProviderSessionClaimKey(target)
  const others = new Set<string>()
  for (const record of Object.values(records)) {
    const claimKey = getProviderSessionClaimKey(record)
    if (record.worktreeId === worktreeId && claimKey !== targetClaimKey) {
      others.add(claimKey)
    }
  }
  return others
}

/**
 * Resume one slept conversation in place when its row is opened. Reuses the mounted panes' armed
 * hibernation wake (the mobile wake fanout); every other sleeping session is pre-claimed so it
 * stays asleep. An unmounted pane needs nothing here — mounting it cold-restores its `--resume`.
 */
export function wakeSleptSessionPane(worktreeId: string, paneKey: string): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  const state = useAppStore.getState()
  // Why (C4/F10): a pane a paired OmniConsole executes is resumed by its owner, never woken from
  // this computer's record of it; local and direct-SSH panes wake as before.
  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  if (isPairedOwnerConversation(state.mirroredConversationOwnersByEnvironment, { hostId })) {
    return false
  }
  const records = state.sleepingAgentSessionsByPaneKey
  const wokenClaimKeys = otherSleepingClaimKeys(records, worktreeId, paneKey)
  if (!wokenClaimKeys) {
    return false
  }
  const alreadyClaimed = wokenClaimKeys.size
  window.dispatchEvent(
    new CustomEvent<WakeHibernatedAgentsWorktreeDetail>(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, {
      detail: { worktreeId, wokenClaimKeys }
    })
  )
  return wokenClaimKeys.size > alreadyClaimed
}
