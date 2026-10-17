import type { HibernationEvidence, IDLE_RULE } from '../../../../shared/idle-auto-close-settings'

export type IdleRule = typeof IDLE_RULE.R2 | typeof IDLE_RULE.R3

/** One terminal tab of a workspace R2 would put to sleep: its panes and their PTYs. */
export type IdleShellTab = { tabId: string; paneKeys: string[]; ptyIds: string[] }

/** One rule's verdict on one target this tick. */
export type IdleDecision = {
  rule: IdleRule
  /** The workspace (worktree) id, for both rules. */
  key: string
  verdict: 'act' | 'skip'
  reason: string
  evidence: HibernationEvidence
  /** Changes whenever the facts behind an `act` change; two ticks must agree before acting. */
  signature: string
  worktreeId: string | null
  target: { paneKey?: string | null; tabId?: string | null; title?: string }
  /** R2: every terminal tab of the workspace, whose panes and PTYs the act re-checks (G4). */
  shellTabs?: IdleShellTab[]
}

export type ProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
}

/** Local daemon ids only: `remote:` runtime handles and `ssh:` relay ids run elsewhere. */
export function isLocalDaemonPtyId(ptyId: string): boolean {
  return !ptyId.startsWith('remote:') && !ptyId.startsWith('ssh:')
}
