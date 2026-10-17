import { prependSessionContext } from '@/lib/session-context-delivery'
import {
  classifyStructuredAgentSessionSendFailure,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  refreshSessionTaskContext,
  sessionTaskContextIsCurrent,
  type PreparedTaskContext
} from '@/lib/session-task-context'

/** Freeze the brief with the first host attempt, so uncertain retries stay identical. */
export async function prepareStructuredOutboxDispatch(
  entry: StructuredAgentSessionOutboxEntry,
  hostId: string,
  isCurrent: () => boolean
): Promise<{ entry: StructuredAgentSessionOutboxEntry; commit(): void }> {
  let outgoing = entry
  let context: PreparedTaskContext | undefined
  if (entry.lastAttemptAt === null && entry.taskContextFence) {
    const text = entry.body.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    context = await refreshSessionTaskContext(text, entry.taskContextFence.sourceKey, hostId)
    outgoing = {
      ...entry,
      body: {
        ...entry.body,
        blocks: [
          ...(context.text.trim() ? [{ type: 'text' as const, text: context.text }] : []),
          ...entry.body.blocks.filter((block) => block.type !== 'text')
        ]
      }
    }
  }
  if (entry.lastAttemptAt === null) {
    const text = outgoing.body.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
    const attached = prependSessionContext(text, entry.sessionId, hostId)
    if (attached !== text) {
      outgoing = {
        ...outgoing,
        body: {
          ...outgoing.body,
          blocks: [
            { type: 'text', text: attached },
            ...outgoing.body.blocks.filter((block) => block.type !== 'text')
          ]
        }
      }
    }
  }
  if (
    !isCurrent() ||
    (entry.taskContextFence && !sessionTaskContextIsCurrent(entry.taskContextFence, hostId))
  ) {
    throw new Error('The task binding or execution session changed. Your message is kept.')
  }
  return { entry: outgoing, commit: () => context?.commit() }
}

export function classifyStructuredDispatchFailure(error: unknown, attemptedHost: boolean) {
  return attemptedHost
    ? classifyStructuredAgentSessionSendFailure(error, (caught) =>
        /timeout|disconnect|connection|closed|unavailable|cutover/i.test(String(caught))
      )
    : 'failed'
}
