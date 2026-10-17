/**
 * Codex sends no hook when it exits, so an async question it left open would stay in Needs you
 * after the person quit it; over SSH nothing else notices (foreground tracking is off for remote
 * PTYs). While any pane carries one, its execution host is asked every `intervalMs` whether the
 * agent is still there, and only positive evidence that it left (`agent-gone`) drops the question:
 * an unreadable host, a stopped job or a replaced terminal proves nothing
 * (`docs/reference/ssh-execution-boundary.md`).
 */

import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { TerminalProcessTree } from '../../shared/pty-agent-process-evidence'
import { pendingSessionAsk } from '../../shared/session-questions'

export const ASYNC_QUESTION_EXIT_SWEEP_MS = 15_000

export type AsyncQuestionExitSweepDeps = {
  statuses: () => readonly AgentStatusIpcPayload[]
  handleForPane: (paneKey: string) => string | null
  readEvidence: (handle: string) => Promise<{ proof: unknown; tree: TerminalProcessTree } | null>
  dropQuestion: (paneKey: string) => void
}

/** One pass: drops the async question of each pane whose host proves its agent gone. */
export async function sweepAsyncQuestionsOfExitedAgents(
  deps: AsyncQuestionExitSweepDeps
): Promise<void> {
  const asking = deps
    .statuses()
    .filter(
      (status) =>
        status.providerSessionOnly !== true && pendingSessionAsk(status)?.delivery === 'async'
    )
  for (const status of asking) {
    let handle: string | null = null
    try {
      handle = deps.handleForPane(status.paneKey)
    } catch {
      handle = null
    }
    const evidence = handle ? await deps.readEvidence(handle).catch(() => null) : null
    if (evidence && !evidence.proof && evidence.tree.kind === 'agent-gone') {
      deps.dropQuestion(status.paneKey)
    }
  }
}

export function startAsyncQuestionExitSweep(
  deps: AsyncQuestionExitSweepDeps,
  intervalMs = ASYNC_QUESTION_EXIT_SWEEP_MS
): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) {
      return
    }
    running = true
    void sweepAsyncQuestionsOfExitedAgents(deps)
      .catch((error: unknown) => console.warn('[agent-hooks] async question sweep failed:', error))
      .finally(() => {
        running = false
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
