/**
 * What an async-question answer (`agent-question-message-answer.ts`) reads besides the question
 * itself: whether the person may already have answered it in Codex's own box, which hook reports
 * its write fence may let pass, and which writer errors prove that no byte landed.
 */

import { asyncAskPendingInStatus, quotedQuestionLine } from '../../shared/codex-async-question'
import { parseAskFromStatus } from '../../shared/native-chat-ask'
import {
  GUARDED_WRITE_FENCE_REVOKED,
  GUARDED_WRITE_RECEIVER_CHANGED,
  GUARDED_WRITE_UNSUPPORTED
} from '../pty/guarded-pty-write'
import { lastTerminalKeyboardSubmitAt } from '../session-prep/terminal-keyboard-submits'
import { asyncQuestionTurnEndedAt } from './async-question-answer-claims'
import { UNRESOLVED_DRAFT_REASON } from './terminal-unresolved-draft'

/**
 * Codex reports the turn a person's Enter started seconds later (its prompt hooks run first); an
 * Enter this long ago that still started no turn submitted nothing.
 */
export const PERSON_SUBMIT_HOLD_MS = 60_000

/**
 * The person pressed Enter in this terminal after Codex ended the turn that left the question
 * waiting, and Codex has not reported a new turn since: they may have answered it in its own box.
 * Why the turn's end, not the asking: a message typed while the turn still ran cleared the
 * questions through its own prompt hook.
 */
export function personMayHaveAnswered(
  paneKey: string,
  ptyId: string,
  rowStateStartedAt: number,
  now: number = Date.now()
): boolean {
  const submitted = lastTerminalKeyboardSubmitAt(ptyId)
  if (submitted === null || now - submitted > PERSON_SUBMIT_HOLD_MS) {
    return false
  }
  // Why the row's time only as a fallback: after a restart main has not heard this turn end.
  return submitted >= (asyncQuestionTurnEndedAt(paneKey) ?? rowStateStartedAt)
}

type HookReport = {
  toolAgentId?: unknown
  payload?: { state?: unknown; workingMode?: unknown; interactivePrompt?: unknown }
}

/**
 * A report a child agent sent, after which every question this answer is for is still pending.
 * Why only these: a child's tool calls come and go while the lead idles at its composer, and none
 * of them touches it; a child's approval or question makes the pane wait, which is not pending.
 */
export function childReportKeepsQuestions(report: unknown, questions: readonly string[]): boolean {
  const { toolAgentId, payload } = (report ?? {}) as HookReport
  if (typeof toolAgentId !== 'string' || !toolAgentId || !payload) {
    return false
  }
  const state = typeof payload.state === 'string' ? payload.state : ''
  const workingMode = typeof payload.workingMode === 'string' ? payload.workingMode : undefined
  const ask =
    typeof payload.interactivePrompt === 'string'
      ? parseAskFromStatus(payload.interactivePrompt)
      : null
  if (ask?.delivery !== 'async' || !asyncAskPendingInStatus({ state, workingMode }, 'async')) {
    return false
  }
  const lines = new Set(ask.questions.map((question) => quotedQuestionLine(question.question)))
  return questions.every((question) => lines.has(question))
}

/** Errors the writer raises only before a byte of the refused write reached the terminal. */
const NOTHING_WRITTEN = new Set([
  GUARDED_WRITE_FENCE_REVOKED,
  GUARDED_WRITE_RECEIVER_CHANGED,
  GUARDED_WRITE_UNSUPPORTED,
  UNRESOLVED_DRAFT_REASON,
  'terminal_not_writable'
])

export function writeRefusedWholly(error: unknown): boolean {
  return error instanceof Error && NOTHING_WRITTEN.has(error.message)
}
