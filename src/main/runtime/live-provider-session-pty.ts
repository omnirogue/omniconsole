import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'

/**
 * Why: on 5 Oct 2026 a paired MacBook opened a Mac Studio conversation (abbed8e3) that an
 * automation pane on the Studio was still running, and `terminal.ensureAgentSession` started a
 * second `claude --resume` beside it. The claim registry only knows terminals that
 * ensureAgentSession itself started, so any conversation launched another way (automation, a new
 * agent tab, the CLI, a shell) was invisible to it, and "view this session" restarted it instead
 * of letting the person steer the one already running. The host's own hook rows say which
 * conversation each pane carries; these are the panes worth proving live before spawning.
 */

export type ProviderSessionPtyRecord = {
  ptyId: string
  worktreeId: string
  tabId: string | null
  paneKey: string | null
  connected: boolean
  lastOutputAt: number | null
}

export type PaneProviderSession = {
  agent: string | null
  providerSession: AgentProviderSessionMetadata | null
}

/**
 * Connected panes in the workspace whose newest hook row names this conversation, most recently
 * active first. Identity only: a pane's last `done` row outlives its agent, so callers must still
 * prove the agent process is in the foreground before reusing the pane.
 */
export function selectProviderSessionPtyCandidates<T extends ProviderSessionPtyRecord>(args: {
  ptys: Iterable<T>
  worktreeId: string
  agent: string
  providerSessionId: string
  worktreeIdsEqual: (left: string, right: string) => boolean
  paneProviderSession: (paneKey: string) => PaneProviderSession
}): (T & { tabId: string; paneKey: string })[] {
  const candidates: (T & { tabId: string; paneKey: string })[] = []
  for (const pty of args.ptys) {
    if (
      !pty.connected ||
      !pty.tabId ||
      !pty.paneKey ||
      !args.worktreeIdsEqual(pty.worktreeId, args.worktreeId)
    ) {
      continue
    }
    const pane = args.paneProviderSession(pty.paneKey)
    if (pane.agent !== args.agent || pane.providerSession?.id !== args.providerSessionId) {
      continue
    }
    candidates.push(pty as T & { tabId: string; paneKey: string })
  }
  return candidates.sort((left, right) => (right.lastOutputAt ?? 0) - (left.lastOutputAt ?? 0))
}
