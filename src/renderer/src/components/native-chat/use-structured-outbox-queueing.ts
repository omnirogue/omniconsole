import { useCallback, type MutableRefObject } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  retryStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/structured-agent-session-projection'
import { prepareSessionTaskContext } from '@/lib/session-task-context'
import { writeOutbox } from './structured-agent-session-outbox-storage'

const OUTBOX_WRITE_FAILED = 'Message could not be saved to the outbox'

export type StructuredOutboxQueueingRefs = {
  sessionId: string
  hostId: string
  outboxRef: MutableRefObject<StructuredAgentSessionOutboxEntry[]>
  setOutbox: (next: StructuredAgentSessionOutboxEntry[]) => void
  setError: (message: string | null) => void
  newOperationId: () => string
}

/** Queue a composed message for this session, with its task context attached. */
export function useStructuredOutboxSend(
  args: StructuredOutboxQueueingRefs
): (text: string, attachments?: readonly { path: string; previewUri: string }[]) => boolean {
  const { sessionId, hostId, outboxRef, setOutbox, setError, newOperationId } = args
  return useCallback(
    (text: string, attachments: readonly { path: string; previewUri: string }[] = []): boolean => {
      if (!text.trim() && attachments.length === 0) {
        return false
      }
      const context = prepareSessionTaskContext(
        text,
        structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId),
        hostId
      )
      const entry = createStructuredAgentSessionOutboxEntry({
        clientMessageId: newOperationId(),
        sessionId,
        text,
        attachments,
        queuedAt: Date.now()
      })
      if (context.fence) {
        entry.taskContextFence = context.fence
      }
      const next = [...outboxRef.current, entry]
      if (!writeOutbox(sessionId, next)) {
        setError(OUTBOX_WRITE_FAILED)
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      setError(null)
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters are stable
    [hostId, sessionId]
  )
}

/**
 * The person's Retry. It clears what stopped the entry automatically — the block
 * on the head and the spent probe budget — so a retried entry is asked about
 * again instead of ending at the ceiling on its first tick.
 */
export function retryStructuredOutboxEntry(
  clientMessageId: string,
  args: StructuredOutboxQueueingRefs & {
    submissions: readonly AgentJournalSubmission[]
    attemptsRef: MutableRefObject<{ id: string | null; attempts: number }>
    ceilingIdRef: MutableRefObject<string | null>
    blockedIdRef: MutableRefObject<string | null>
  }
): void {
  args.blockedIdRef.current = null
  if (args.attemptsRef.current.id === clientMessageId) {
    args.attemptsRef.current = { id: null, attempts: 0 }
  }
  if (args.ceilingIdRef.current === clientMessageId) {
    args.ceilingIdRef.current = null
  }
  args.setError(null)
  const next = retryStructuredAgentSessionOutbox(
    args.outboxRef.current,
    args.submissions,
    clientMessageId,
    args.newOperationId
  )
  if (!writeOutbox(args.sessionId, next)) {
    args.setError(OUTBOX_WRITE_FAILED)
    return
  }
  args.outboxRef.current = next
  args.setOutbox(next)
}
