import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import {
  describeDeadAutomationTerminal,
  hasAutomationTerminalChrome
} from '../../shared/automation-terminal-chrome'
import { readCodexRolloutTurnResult } from './codex-rollout-turn-result'

export const NO_NEW_TURN_ERROR =
  'The agent did not answer this run: its transcript shows no new turn after the prompt was sent.'

/**
 * The last word on a `completed` write, whoever made it (renderer observer, main watcher,
 * headless). A Codex run whose thread is known gets its message from the rollout; a run
 * whose only evidence is a dead-TUI screen scrape is a failure, not a completion.
 */
export function reconcileCompletedAutomationRun(
  result: AutomationDispatchResult,
  findRun: () => AutomationRun | null,
  readRollout: (path: string) => string | null
): AutomationDispatchResult {
  if (result.status !== 'completed') {
    return result
  }
  const run = findRun()
  const snapshot = result.outputSnapshot ?? run?.outputSnapshot ?? null
  const agent = result.providerSession?.providerSessionAgent ?? run?.providerSessionAgent
  const transcriptPath =
    result.providerSession?.providerSessionTranscriptPath ?? run?.providerSessionTranscriptPath
  const startedAt = run?.startedAt ?? run?.dispatchedAt ?? run?.createdAt
  const dead = snapshot ? describeDeadAutomationTerminal(snapshot.content) : null
  const rollout =
    agent === 'codex' && transcriptPath && typeof startedAt === 'number'
      ? readRollout(transcriptPath)
      : null
  if (rollout === null) {
    return dead ? { ...result, status: 'dispatch_failed', error: dead } : result
  }
  const turn = readCodexRolloutTurnResult(rollout, startedAt as number)
  if (turn) {
    return {
      ...result,
      outputSnapshot: {
        format: 'plain_text',
        content: turn.message,
        capturedAt: turn.completedAt,
        truncated: false
      }
    }
  }
  if (!snapshot || hasAutomationTerminalChrome(snapshot.content)) {
    return { ...result, status: 'dispatch_failed', error: dead ?? NO_NEW_TURN_ERROR }
  }
  return result
}
