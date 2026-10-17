import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  reconcileStructuredAgentSessionOutbox,
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'
import { sessionTaskContextIsCurrent } from '@/lib/session-task-context'
import {
  prepareStructuredOutboxDispatch,
  classifyStructuredDispatchFailure
} from './structured-agent-session-outbox-dispatch'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  structuredOutboxProbeId,
  structuredOutboxProbeSettled,
  useStructuredOutboxUnconfirmedProbe
} from './use-structured-outbox-unconfirmed-probe'
import {
  retryStructuredOutboxEntry,
  useStructuredOutboxSend
} from './use-structured-outbox-queueing'

export function structuredSessionOperationId(): string {
  return createStructuredAgentSessionOperationId(() => crypto.randomUUID())
}

export function useStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  fence: number | null
  enabled?: boolean
  submissions: readonly AgentJournalSubmission[]
}) {
  const { fence, sessionId, submissions, target, enabled = true } = args
  const accountScope = useAppStore(selectConsoleAccountScope)
  const hostId = target.kind === 'local' ? 'local' : toRuntimeExecutionHostId(target.environmentId)
  const targetKey = target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
  const [outbox, setOutbox] = useState<StructuredAgentSessionOutboxEntry[]>(() =>
    readOutbox(sessionId)
  )
  const outboxRef = useRef(outbox)
  const outboxSessionRef = useRef(sessionId)
  const dispatchingRef = useRef(false)
  const dispatchGenerationRef = useRef(0)
  const blockedIdRef = useRef<string | null>(null)
  const probeAttemptsRef = useRef({ id: null as string | null, attempts: 0 })
  /** The unconfirmed entry whose probes are spent and now needs the person's call. */
  const probeCeilingIdRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorSession, setErrorSession] = useState(sessionId)
  // Render-time reset (react.dev: adjusting state when a prop changes), so the
  // old session's banner neither flashes for a frame nor resurrects on return.
  if (errorSession !== sessionId) {
    setErrorSession(sessionId)
    setError(null)
  }

  useEffect(() => {
    outboxRef.current = outbox
  }, [outbox])

  useLayoutEffect(() => {
    dispatchGenerationRef.current += 1
    dispatchingRef.current = false
    blockedIdRef.current = null
    probeAttemptsRef.current = { id: null, attempts: 0 }
    probeCeilingIdRef.current = null
  }, [accountScope, enabled, fence, sessionId, targetKey])

  useEffect(() => {
    const sessionChanged = outboxSessionRef.current !== sessionId
    outboxSessionRef.current = sessionId
    const current = sessionChanged ? readOutbox(sessionId) : outboxRef.current
    const next = current.map((entry) =>
      entry.state === 'dispatching' ? { ...entry, state: 'queued' as const } : entry
    )
    if (
      sessionChanged ||
      next.some((entry, index) => entry !== current[index]) ||
      next.length !== current.length
    ) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
  }, [fence, sessionId, target])

  useEffect(() => {
    const next = reconcileStructuredAgentSessionOutbox(outboxRef.current, submissions)
    if (
      next.some((entry, index) => entry !== outboxRef.current[index]) ||
      next.length !== outboxRef.current.length
    ) {
      outboxRef.current = next
      setOutbox(next)
      writeOutbox(sessionId, next)
    }
  }, [sessionId, submissions])

  useEffect(() => {
    const next = outbox[0]
    if (
      !enabled ||
      !next ||
      next.sessionId !== sessionId ||
      next.state !== 'queued' ||
      fence === null ||
      dispatchingRef.current ||
      blockedIdRef.current === next.clientMessageId
    ) {
      return
    }
    if (next.taskContextFence && !sessionTaskContextIsCurrent(next.taskContextFence, hostId)) {
      setError(
        'This queued task context belongs to another account or execution session. Return to that account and session to send it.'
      )
      return
    }
    dispatchingRef.current = true
    const dispatchGeneration = dispatchGenerationRef.current
    let attemptedHost = false
    const dispatch = async () => {
      const prepared = await prepareStructuredOutboxDispatch(
        next,
        hostId,
        () => dispatchGenerationRef.current === dispatchGeneration
      )
      const outgoing = prepared.entry
      const staged = outboxRef.current.map((entry) =>
        entry.clientMessageId === next.clientMessageId
          ? { ...outgoing, state: 'dispatching' as const, lastAttemptAt: Date.now() }
          : entry
      )
      if (!writeOutbox(sessionId, staged)) {
        throw new Error('Message could not be saved to the outbox')
      }
      outboxRef.current = staged
      setOutbox(staged)
      prepared.commit()
      attemptedHost = true
      return callStructuredAgentSession<AgentSessionMutationResult<AgentSessionSendResult>>(
        target,
        'agentSession.send',
        structuredAgentSessionSendRequest(outgoing, fence)
      )
    }
    void dispatch()
      .then((result) => {
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        if (!result.ok) {
          setError(result.refusal.message)
          const updated = outboxRef.current.map((entry) =>
            entry.clientMessageId === next.clientMessageId
              ? requeueStructuredAgentSessionSendRefusal(
                  entry,
                  result.refusal.code,
                  structuredSessionOperationId
                )
              : entry
          )
          blockedIdRef.current = updated[0]?.clientMessageId ?? null
          outboxRef.current = updated
          setOutbox(updated)
          writeOutbox(sessionId, updated)
          return
        }
        const submission = result.value.submission
        if (submission.dispatchState === 'rejected') {
          blockedIdRef.current = next.clientMessageId
          setError(submission.reason ?? 'Message was not accepted')
        } else {
          setError(null)
        }
        const updated =
          submission.dispatchState === 'accepted'
            ? outboxRef.current.filter((entry) => entry.clientMessageId !== next.clientMessageId)
            : outboxRef.current.map((entry) =>
                entry.clientMessageId === next.clientMessageId
                  ? {
                      ...entry,
                      state:
                        submission.dispatchState === 'unknown' ||
                        submission.dispatchState === 'pending'
                          ? ('unconfirmed' as const)
                          : ('queued' as const)
                    }
                  : entry
              )
        outboxRef.current = updated
        setOutbox(updated)
        writeOutbox(sessionId, updated)
      })
      .catch((caught) => {
        if (dispatchGenerationRef.current !== dispatchGeneration) {
          return
        }
        const failure = classifyStructuredDispatchFailure(caught, attemptedHost)
        if (failure === 'failed') {
          blockedIdRef.current = next.clientMessageId
        }
        const updated = outboxRef.current.map((entry) =>
          entry.clientMessageId === next.clientMessageId
            ? {
                ...entry,
                state:
                  failure === 'delivery-unknown' ? ('unconfirmed' as const) : ('queued' as const)
              }
            : entry
        )
        setError(
          failure === 'delivery-unknown' ? 'Message delivery is unconfirmed' : String(caught)
        )
        outboxRef.current = updated
        setOutbox(updated)
        writeOutbox(sessionId, updated)
      })
      .finally(() => {
        if (dispatchGenerationRef.current === dispatchGeneration) {
          dispatchingRef.current = false
        }
      })
  }, [accountScope, enabled, fence, hostId, outbox, sessionId, target])

  const probeId = structuredOutboxProbeId(outbox[0], sessionId)
  useStructuredOutboxUnconfirmedProbe({
    probeId,
    probeSettled: structuredOutboxProbeSettled(probeId, submissions),
    fence: enabled ? fence : null,
    sessionId,
    targetKey,
    attemptsRef: probeAttemptsRef,
    ceilingIdRef: probeCeilingIdRef,
    blockedIdRef,
    outboxRef,
    setOutbox,
    setError
  })

  const queueing = {
    sessionId,
    hostId,
    outboxRef,
    setOutbox,
    setError,
    newOperationId: structuredSessionOperationId
  }
  const send = useStructuredOutboxSend(queueing)
  const retry = (clientMessageId: string): void =>
    retryStructuredOutboxEntry(clientMessageId, {
      ...queueing,
      submissions,
      attemptsRef: probeAttemptsRef,
      ceilingIdRef: probeCeilingIdRef,
      blockedIdRef
    })
  return {
    outbox,
    error,
    blockedClientMessageId: blockedIdRef.current,
    /** Unconfirmed, probes spent: waiting on the person, not on the transport. */
    unconfirmedNeedsDecisionId: probeCeilingIdRef.current,
    send: (...input: Parameters<typeof send>) => enabled && send(...input),
    retry: (id: string) => {
      if (enabled) {
        retry(id)
      }
    }
  }
}
