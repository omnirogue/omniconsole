import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { RestoredStructuredAgentSessionRead } from './structured-agent-session-read-restore'

export function observeRestoredTaskPublication(
  context: Pick<StructuredAgentSessionAttachContext, 'deps' | 'sessions' | 'subscribers'>,
  sessionId: string,
  restored: RestoredStructuredAgentSessionRead
): void {
  const record = context.deps.store.getRecord(sessionId)
  if (!record) {
    return
  }
  const isCurrent = (taskId: string) => {
    const current = context.deps.store.getRecord(sessionId)
    return (
      current?.hubTaskId === taskId &&
      current.lease.runtimeFence === restored.fence &&
      context.sessions.get(sessionId)?.journal === restored.journal
    )
  }
  context.subscribers.taskSave(sessionId, restored.fence, null)
  try {
    context.deps.onJournalReady?.({
      record,
      cursor: restored.journal.cursor(),
      journal: restored.journal,
      readOnly: true,
      isCurrent,
      onTaskSave: (status) => {
        if (isCurrent(status.taskId)) {
          context.subscribers.taskSave(sessionId, restored.fence, status)
        }
      }
    })
  } catch (error) {
    context.deps.onEventSinkError?.({ sessionId, error })
  }
}
