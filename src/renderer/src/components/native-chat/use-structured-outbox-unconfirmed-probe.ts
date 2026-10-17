import { useEffect, type MutableRefObject } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  nextStructuredOutboxProbeDelayMs,
  STRUCTURED_OUTBOX_UNCONFIRMED_DECISION_MESSAGE
} from '../../../../shared/structured-agent-session-outbox-probe'
import { writeOutbox } from './structured-agent-session-outbox-storage'

/**
 * Which unconfirmed entry may be re-issued automatically.
 *
 * A non-null `retryAfterUnknownSubmittedAt` means the person already force-retried,
 * so the request would carry `retryUnknown` and redispatch host-side; only entries
 * that have never been force-retried are safe to re-issue on their own.
 */
export function structuredOutboxProbeId(
  head: StructuredAgentSessionOutboxEntry | undefined,
  sessionId: string
): string | null {
  return head &&
    head.sessionId === sessionId &&
    head.state === 'unconfirmed' &&
    head.retryAfterUnknownSubmittedAt === null
    ? head.clientMessageId
    : null
}

export function structuredOutboxProbeSettled(
  probeId: string | null,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  return (
    probeId !== null && submissions.some((submission) => submission.clientMessageId === probeId)
  )
}

/**
 * Re-issue an unconfirmed head until the host answers, then stop and ask.
 *
 * A transport-side unknown may never have reached the host, and nothing else moves
 * it out of `unconfirmed`, so one wedges the whole FIFO queue. Re-issuing the same
 * envelope without `retryUnknown` is idempotent: the operation ledger replays a
 * recorded outcome, or the host performs a genuine first delivery. Once the probe
 * budget is spent the delivery becomes the person's decision rather than an endless
 * wait — Retry re-arms it from zero.
 *
 * Deps are primitives on purpose: `submissions` is rebuilt on every streaming
 * batch, so an array-identity dep would reset the backoff forever while the agent
 * is working.
 */
export function useStructuredOutboxUnconfirmedProbe(args: {
  probeId: string | null
  probeSettled: boolean
  fence: number | null
  sessionId: string
  targetKey: string
  attemptsRef: MutableRefObject<{ id: string | null; attempts: number }>
  ceilingIdRef: MutableRefObject<string | null>
  blockedIdRef: MutableRefObject<string | null>
  outboxRef: MutableRefObject<StructuredAgentSessionOutboxEntry[]>
  setOutbox: (next: StructuredAgentSessionOutboxEntry[]) => void
  setError: (message: string) => void
}): void {
  const {
    probeId,
    probeSettled,
    fence,
    sessionId,
    targetKey,
    attemptsRef,
    ceilingIdRef,
    blockedIdRef,
    outboxRef,
    setOutbox,
    setError
  } = args
  useEffect(() => {
    if (probeId === null || probeSettled || fence === null) {
      return
    }
    const attempts = attemptsRef.current.id === probeId ? attemptsRef.current.attempts : 0
    const delayMs = nextStructuredOutboxProbeDelayMs(attempts)
    if (delayMs === null) {
      // Why stop: the probes are spent, so this delivery is a decision rather than
      // a wait. The entry stays `unconfirmed` and the head stops re-dispatching.
      ceilingIdRef.current = probeId
      blockedIdRef.current = probeId
      setError(STRUCTURED_OUTBOX_UNCONFIRMED_DECISION_MESSAGE)
      return
    }
    const timer = setTimeout(() => {
      attemptsRef.current = { id: probeId, attempts: attempts + 1 }
      const next = outboxRef.current.map((entry) =>
        entry.clientMessageId === probeId ? { ...entry, state: 'queued' as const } : entry
      )
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }, delayMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters are stable; see the note above on primitive deps
  }, [fence, probeId, probeSettled, sessionId, targetKey])
}
