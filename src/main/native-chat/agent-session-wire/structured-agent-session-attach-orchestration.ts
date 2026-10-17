import { normalizeLaunchCause, type LaunchCause } from '../../../shared/launch-cause'
import { attemptLaunchProvenance } from '../../launch-ledger/launch-provenance-guard'
import type {
  NativeJournalObservation,
  StructuredAgentSessionCaller
} from './structured-agent-session-host-types'
import { recoverInterruptedCompaction } from './structured-compaction-recovery'
// The host's attach, lifted out of the host class.
//
// Attach is the one operation that touches every collaborator the host owns — the lease
// reconciler, the recovery resolver, the event sink, the journal, the subscriber set and the task
// queue — so leaving it inline made the host grow every time any of them did. The host keeps the
// state; this owns the ordering between them.

import { randomUUID } from 'node:crypto'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv,
  pinnedAgentSessionHubTaskId
} from './structured-agent-session-launch-env'
import { refuseAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function attachStructuredAgentSessionForCaller(
  context: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return attachStructuredAgentSession(
    context,
    caller.callerKey,
    params,
    undefined,
    attemptLaunchProvenance('structured-agent-session', () => caller.launchCause, {
      trigger: 'unknown'
    })
  )
}

export function attachStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  admitRecoveryTicket?: () => boolean,
  launchCause?: LaunchCause
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const sessionId = params.envelope.sessionId
  const attaching = context.serialize(sessionId, async () => {
    if (admitRecoveryTicket && !admitRecoveryTicket()) {
      return refuseAgentSessionMutation({
        code: 'agent_session_checkpoint_stale',
        message: 'The provider-exit recovery ticket is no longer current.'
      })
    }
    const unreconciled = await context.reconcileLeases(sessionId)
    if (unreconciled) {
      return refuseAgentSessionMutation(unreconciled)
    }
    await context.runtimeState.resolveRecovery(sessionId)
    if (context.retryPendingSettlement) {
      const settled = await context.retryPendingSettlement(sessionId, params)
      if (!settled) {
        return refuseAgentSessionMutation({
          code: 'agent_session_ownership_unknown',
          message: 'The provider-exit terminal journal settlement is still pending; retry attach.'
        })
      }
    }
    const eventSink = context.runtimeState.eventSinkFor(sessionId)
    let startedCursor: AgentJournalCursor | null = null
    const attached = await performAttach({
      store: context.deps.store,
      adapter: context.deps.adapter,
      journalRoot: context.deps.journalRoot,
      eventSink: eventSink.sink,
      onAcquiring: async () => {
        const barrier = await eventSink.drained()
        if (!barrier.ok) {
          throw barrier.error
        }
        eventSink.unbind()
      },
      authority: {
        launchCause: attemptLaunchProvenance<LaunchCause>(
          'structured-agent-session',
          () =>
            normalizeLaunchCause(
              launchCause ?? {
                trigger:
                  params.envelope.expectedRuntimeFence === null
                    ? 'agent-session-create'
                    : 'agent-session-resume',
                actor: { kind: 'app' }
              }
            ),
          { trigger: 'unknown' }
        ),
        spawnToken: () => context.deps.mintSpawnToken?.() ?? randomUUID(),
        claimKeyId: context.deps.claimKeyId,
        handoffOperationId: params.envelope.clientOperationId,
        probe: await context.runtimeState.probeOwner(sessionId),
        ...(await pinnedAgentSessionLaunchArgs(context.deps.resolveLaunchArgs, params)),
        ...(await pinnedAgentSessionLaunchEnv(context.deps.resolveLaunchEnv, params)),
        ...(await pinnedAgentSessionHubTaskId(
          context.deps.resolveWorkspaceHubTaskId,
          params,
          context.deps.store.getRecord(sessionId)
        ))
      },
      callerKey,
      params,
      now: () => context.now(),
      // Site 9: this closes the PRIOR map entry it drops, never the provisional
      // journal — it has no reference to that one. `onAttached` owns that.
      onAttachFailed: async () => {
        await context.sessions.get(sessionId)?.journal.close()
        context.sessions.delete(sessionId)
        context.subscribers.statusChanged?.(sessionId)
        eventSink.close()
        context.runtimeState.discardEventSink(sessionId)
      },
      onAttached: async (attached, acquisitionGeneration) => {
        startedCursor = attached.recovery ? null : attached.journal.creationCursor
        const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0
        const previous = context.sessions.get(sessionId)
        const previousFence = previous?.fence
        const isCurrent = (taskId: string) => {
          const current = context.deps.store.getRecord(sessionId)
          return (
            current?.hubTaskId === taskId &&
            current.lease.runtimeFence === fence &&
            context.sessions.get(sessionId)?.journal === attached.journal
          )
        }
        const onTaskSave: NativeJournalObservation['onTaskSave'] = (status) => {
          if (isCurrent(status.taskId)) {
            context.subscribers.taskSave(sessionId, fence, status)
          }
        }
        // Site 8: the provisional journal has no owner until the map takes it,
        // and the barrier below throws by design.
        try {
          await bindAndDrain(
            eventSink,
            attached.journal,
            fence,
            () => context.subscribers.publish(sessionId, attached.journal),
            (cursor) => {
              const record = context.deps.store.getRecord(sessionId)
              if (record?.lease.runtimeFence === fence) {
                return context.deps.onJournalCheckpoint?.({
                  record,
                  cursor,
                  journal: attached.journal,
                  isCurrent,
                  onTaskSave
                })
              }
            }
          )
        } catch (error) {
          await agentSessionJournalCloseRetries.closeOrRetain(attached.journal)
          throw error
        }
        // Site 10: a `set` over a live entry would orphan its handle — and a
        // close that REJECTED did not release it. The replacement is therefore
        // ABORTED rather than completed over a handle nothing can reach again:
        // `previous` stays indexed, so teardown still owns it and can retry.
        if (previous && previous.journal !== attached.journal) {
          try {
            await previous.journal.close()
          } catch (error) {
            await agentSessionJournalCloseRetries.closeOrRetain(attached.journal)
            throw error
          }
        }
        context.sessions.set(sessionId, {
          journal: attached.journal,
          params,
          fence,
          hasProviderChild: true,
          acquisitionGeneration: acquisitionGeneration ?? previous?.acquisitionGeneration ?? null
        })
        context.subscribers.taskSave(sessionId, fence, null)
        await recoverInterruptedCompaction(context.deps.store, sessionId, attached.journal, fence)
        if (attached.recovery) {
          context.subscribers.reset(sessionId, attached.journal, attached.recovery.reset, fence)
        } else if (previousFence !== undefined && previousFence !== fence) {
          context.subscribers.snapshot(sessionId, attached.journal, fence)
        } else {
          context.subscribers.publish(sessionId, attached.journal)
        }
        const record = context.deps.store.getRecord(sessionId)
        if (record) {
          context.deps.onJournalReady?.({
            record,
            journal: attached.journal,
            cursor: attached.journal.cursor(),
            isCurrent,
            onTaskSave
          })
        }
      }
    })
    // Why: a failed attach that left no session behind must not strand a bound sink; the runtime
    // caches one per session id and would hand this same closed instance to the next attempt.
    if (!attached.ok && !context.sessions.has(sessionId)) {
      eventSink.close()
      context.runtimeState.discardEventSink(sessionId)
    }
    if (attached.ok && startedCursor) {
      const record = context.deps.store.getRecord(sessionId)
      if (record) {
        try {
          const session = context.sessions.get(sessionId)
          if (session) {
            await context.deps.onSessionStarted?.({
              record,
              cursor: startedCursor,
              journal: session.journal,
              onTaskSave: (status) => {
                const current = context.deps.store.getRecord(sessionId)
                if (
                  current?.hubTaskId === status.taskId &&
                  current.lease.runtimeFence === session.fence &&
                  context.sessions.get(sessionId)?.journal === session.journal
                ) {
                  context.subscribers.taskSave(sessionId, session.fence, status)
                }
              },
              isCurrent: (taskId) => {
                const current = context.deps.store.getRecord(sessionId)
                return (
                  current?.hubTaskId === taskId &&
                  current.lease.runtimeFence === session.fence &&
                  context.sessions.get(sessionId)?.journal === session.journal
                )
              }
            })
          }
        } catch (error) {
          context.deps.onEventSinkError?.({ sessionId, error })
        }
      }
    }
    return attached
  })
  return context.tasks.trackAttach(attaching)
}

/** Binds the sink to the journal and waits for the barrier the host publishes
 *  behind. It throws by design when a sink barrier fails. */
async function bindAndDrain(
  eventSink: DeferredStructuredAgentSessionEventSink,
  journal: AgentSessionJournal,
  fence: number,
  publish: () => void,
  checkpointWritten?: (cursor: AgentJournalCursor) => void | Promise<void>
): Promise<void> {
  eventSink.bind({ journal, fence, publish, ...(checkpointWritten ? { checkpointWritten } : {}) })
  const barrier = await eventSink.drained()
  if (!barrier.ok) {
    throw barrier.error
  }
}
