/**
 * R3, pure: an in-app browser workspace hidden for the idle window has its pages discarded. URL,
 * title and zoom stay in the store, and the page reloads when its workspace is shown again (the
 * browser budget's own eviction path). R2 lives in idle-auto-close-bare-shell-rule.ts; R1 (agent
 * sleep) runs on the agent hibernation planner, so a done agent has exactly one path to sleep.
 */

import { IDLE_RULE, type HibernationEvidence } from '../../../../shared/idle-auto-close-settings'
import type { IdleDecision } from './idle-auto-close-decision'

export type HiddenBrowserInputs = {
  now: number
  idleMs: number
  activeWorktreeId: string | null
  hiddenSinceByWorktreeId: ReadonlyMap<string, number>
  holdsLiveGuests: (worktreeId: string) => boolean
  isEvictable: (worktreeId: string) => boolean
  /** A live page in the workspace is playing sound (music, a call); unknown reads as playing. */
  isPlayingAudio: (worktreeId: string) => boolean
}

/** Why a hidden workspace's pages stay, or null when R3 may discard them now. */
export function hiddenBrowserKeepReason(
  inputs: HiddenBrowserInputs,
  worktreeId: string,
  hiddenSince: number | undefined
): string | null {
  // G3: the rendered workspace, or one whose hidden clock never started, is on screen.
  if (worktreeId === inputs.activeWorktreeId || hiddenSince === undefined) {
    return 'visible'
  }
  if (!inputs.holdsLiveGuests(worktreeId)) {
    return 'no-live-page'
  }
  // G2 is inside this window: a reveal restarts the hidden clock.
  if (inputs.now - hiddenSince < inputs.idleMs) {
    return 'idle-too-short'
  }
  // Why: a page an automation or phone is driving, or one still downloading, stays alive.
  if (!inputs.isEvictable(worktreeId)) {
    return 'page-in-use'
  }
  // Why: discarding stops the music or drops the call, and loses state the page holds in memory.
  if (inputs.isPlayingAudio(worktreeId)) {
    return 'page-playing-audio'
  }
  return null
}

export function planHiddenBrowserDiscards(inputs: HiddenBrowserInputs): IdleDecision[] {
  const decisions: IdleDecision[] = []
  for (const [worktreeId, hiddenSince] of inputs.hiddenSinceByWorktreeId) {
    const evidence: HibernationEvidence = {
      worktreeId,
      hiddenSince,
      hiddenForMs: Math.max(0, inputs.now - hiddenSince),
      idleMs: inputs.idleMs
    }
    const reason = hiddenBrowserKeepReason(inputs, worktreeId, hiddenSince)
    decisions.push({
      rule: IDLE_RULE.R3,
      key: worktreeId,
      verdict: reason ? 'skip' : 'act',
      reason: reason ?? 'idle',
      evidence,
      signature: reason ? '' : `${worktreeId}|${hiddenSince}`,
      worktreeId,
      target: {}
    })
  }
  return decisions
}
