import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'

/** Called after provider-stop proof and journal drain, before ownership is released. */
export async function retainStoppedSessionCloseout(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string
): Promise<void> {
  const session = context.sessions.get(sessionId)
  const record = context.deps.store.getRecord(sessionId)
  if (
    !session?.hasProviderChild ||
    !record ||
    !(context.deps.adapter.disposeSession ?? context.deps.adapter.closeSession)
  ) {
    return
  }
  const fence = session.fence
  const isCurrent = (taskId: string) => {
    const current = context.deps.store.getRecord(sessionId)
    return (
      current?.hubTaskId === taskId &&
      current.lease.runtimeFence === fence &&
      context.sessions.get(sessionId) === session
    )
  }
  await context.deps.onSessionStopped?.({
    record,
    journal: session.journal,
    cursor: session.journal.cursor(),
    isCurrent,
    onTaskSave: (status) => {
      if (isCurrent(status.taskId)) {
        context.subscribers?.taskSave(sessionId, fence, status)
      }
    }
  })
}

export function assertStoppedSessionCurrent(
  context: StructuredAgentSessionLifetimeContext,
  sessionId: string,
  expected: StructuredAgentSessionHostSession,
  expectedFence: number
): void {
  if (
    context.sessions.get(sessionId) !== expected ||
    expected.fence !== expectedFence ||
    (expected.hasProviderChild &&
      context.deps.store.getRecord(sessionId)?.lease.runtimeFence !== expectedFence)
  ) {
    throw new Error('Native closeout ownership changed; refusing stale release.')
  }
}
