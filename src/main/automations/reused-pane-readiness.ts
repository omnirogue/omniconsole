import { describeDeadAutomationTerminal } from '../../shared/automation-terminal-chrome'

const READINESS_TAIL_LINES = 60

/**
 * Refuses to type a routine prompt into a pane whose TUI is dead — Codex's
 * "Conversation interrupted · open in another app · R to Retry" state. The token
 * `not_writable` is what the renderer's reuse branch already treats as "launch a
 * fresh session instead" (PR #460); the sentence after it is for the run record.
 */
export async function assertAutomationPaneAcceptsInput(
  runtime: { readTerminal(handle: string, opts?: { limit?: number }): Promise<{ tail: string[] }> },
  handle: string
): Promise<void> {
  let tail: string[]
  try {
    tail = (await runtime.readTerminal(handle, { limit: READINESS_TAIL_LINES })).tail
  } catch {
    // Why: a pane that cannot be read is judged by the authority checks that follow, not here.
    return
  }
  const dead = describeDeadAutomationTerminal(tail.join('\n'))
  if (dead) {
    throw new Error(`terminal_not_writable: ${dead}`)
  }
}
