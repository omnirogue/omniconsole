import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { isEquivalentPaneKey } from './orchestration/db/pane-key-match'
import { readConversationReport } from './session-outcome-conversation-report'

/** The settlement pins the accepted message before another stage can replace Task.result. */
export function sessionOutcomeResultMessage(
  runtime: OrcaRuntimeService,
  attempt: SessionOutcomeAttempt,
  messageId: string
) {
  if (!attempt.dispatchId || !attempt.taskId) {
    return undefined
  }
  const db = runtime.getOrchestrationDb()
  const message = db.getMessageById(messageId)
  const dispatch = db.getDispatchContextById(attempt.dispatchId)
  try {
    const payload = JSON.parse(message?.payload ?? 'null')
    const senderMatches = dispatch?.assignee_pane_key
      ? Boolean(
          message?.sender_pane_key &&
          isEquivalentPaneKey(dispatch.assignee_pane_key, message.sender_pane_key)
        )
      : message?.from_handle === dispatch?.assignee_handle
    if (
      !senderMatches ||
      message?.type !== 'worker_done' ||
      message.run_id !== attempt.runId ||
      dispatch?.task_id !== attempt.taskId ||
      dispatch.run_id !== attempt.runId ||
      payload?.dispatchId !== attempt.dispatchId ||
      payload.taskId !== attempt.taskId ||
      payload.outcome !== 'succeeded'
    ) {
      return undefined
    }
    return message
  } catch {
    return undefined
  }
}

/**
 * What one finished attempt reported, whatever ran it. The ONE read every downstream consumer
 * goes through — the `readsFrom` excerpts, the review candidate version, the verdict envelope —
 * so a step that continued the original conversation (WP-4b) settles into the same place a
 * worker's report does: its turn's output, written to the step's own `.omni/runs` folder.
 */
export function sessionOutcomeResultBody(
  runtime: OrcaRuntimeService,
  attempt: SessionOutcomeAttempt
): string {
  if (attempt.conversationTurn) {
    return attempt.state === 'completed' && attempt.conversationTurn.reportPath
      ? readConversationReport(attempt.conversationTurn.reportPath)
      : ''
  }
  if (!attempt.taskId || attempt.state !== 'completed') {
    return ''
  }
  if (attempt.nativeContinuation) {
    return attempt.resultMessageId
      ? (sessionOutcomeResultMessage(runtime, attempt, attempt.resultMessageId)?.body ?? '')
      : ''
  }
  const result = runtime.getOrchestrationDb().getTask(attempt.taskId)?.result
  if (!result) {
    return ''
  }
  try {
    const record = JSON.parse(result)
    return typeof record.body === 'string' ? record.body : ''
  } catch {
    return ''
  }
}
