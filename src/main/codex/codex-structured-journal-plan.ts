import { nativeChatPlanBlock, readCodexNativeChatPlan } from '../../shared/native-chat-plan'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexItemTranslation,
  type CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import { readCodexTurnId } from './codex-structured-thread-facts'

export function publishCodexJournalPlan(
  deps: CodexJournalTranslatorDeps,
  event: { threadId: string; params: unknown },
  currentTurnId: string | null
): CodexItemTranslation {
  const primaryThreadId = deps.primaryThreadId?.()
  const turnId = readCodexTurnId(event.params) ?? currentTurnId
  const plan = readCodexNativeChatPlan(event.params)
  // A child thread's plan must not replace the conversation owner's checklist.
  if (!turnId || !plan || (primaryThreadId && primaryThreadId !== event.threadId)) {
    return { handled: false }
  }
  const identity = {
    provider: 'legacy' as const,
    agent: 'codex',
    sessionId: event.threadId,
    recordId: `turn-plan:${turnId}`
  }
  const body = {
    kind: 'message' as const,
    role: 'system' as const,
    blocks: [nativeChatPlanBlock(plan)]
  }
  const options = { coalescingKey: `turn-plan:${event.threadId}:${turnId}` }
  const admission = deps.sink.tryAppendItem
    ? deps.sink.tryAppendItem(identity, body, options)
    : (deps.sink.appendItem(identity, body, options), CODEX_JOURNAL_ADMITTED)
  if (!admission.accepted) {
    return { handled: true, admission }
  }
  return {
    handled: true,
    admission: deps.sink.tryPublish
      ? deps.sink.tryPublish()
      : (deps.sink.publish(), CODEX_JOURNAL_ADMITTED)
  }
}
