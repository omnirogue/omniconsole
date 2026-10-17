// The host's restore-side collaborators, lifted out so the host class stays
// inside its line budget. Both read live host state through the callbacks
// below; nothing here caches a session, a fence or a journal.

import { createRestartReconciler } from './structured-agent-session-restart-reconcile'
import * as providerSupport from './structured-agent-session-provider-support'
import { observeRestoredTaskPublication } from './structured-agent-session-read-publication'
import { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import { revealStructuredAgentSession } from './structured-agent-session-reveal'
import { retryPendingStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import { StructuredAgentSessionRestartRestoreGate } from './structured-agent-session-restart-restore-gate'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHolds } from './structured-agent-session-holds'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionReveal
} from './structured-agent-session-host-types'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export function createStructuredAgentSessionHostRestore(
  deps: StructuredAgentSessionHostDeps,
  host: {
    reconcileLeases: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
    sessions: Map<string, StructuredAgentSessionHostSession>
    subscribers: AgentSessionSubscribers
    runtimeState: StructuredAgentSessionHostRuntimeState
    holds: StructuredAgentSessionHolds
    serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
    attachContext: () => StructuredAgentSessionAttachContext
    restoreHandoff: (sessionId: string) => Promise<void>
    now: () => number
  }
): {
  /** The startup sweep, behind the restart gate that keeps it to one run. */
  restoreReadableSessions: (sessionIds?: readonly string[]) => Promise<void>
  /** One persisted session made addressable again; see `structured-agent-session-reveal`. */
  revealSession: (sessionId: string) => Promise<StructuredAgentSessionReveal>
  eventRecovery: StructuredAgentSessionEventRecovery
} {
  const readableRestorer = new StructuredAgentSessionReadableRestorer({
    store: deps.store,
    journalRoot: deps.journalRoot,
    supportsRecord: (record) => providerSupport.adapterSupportsRecord(deps.adapter, record),
    // A turn the provider was running when this process died has no one left to settle
    // it; the restore is the only moment that can, which is why the retry hangs here
    // rather than on a timer.
    retrySettlement: (sessionId, params) =>
      retryPendingStructuredAgentSessionSettlement({
        deps,
        sessions: host.sessions,
        sessionId,
        params,
        now: host.now
      }),
    reconcile: host.reconcileLeases,
    resolveRecovery: (sessionId) => host.runtimeState.resolveRecovery(sessionId),
    serialize: (sessionId, task) => host.serialize(sessionId, task),
    hasSession: (sessionId) => host.sessions.has(sessionId),
    onReadable: (sessionId, restored) => {
      host.sessions.set(sessionId, restored)
      host.subscribers.statusChanged(sessionId)
      observeRestoredTaskPublication(host.attachContext(), sessionId, restored)
    },
    restoreHandoff: (sessionId) => host.restoreHandoff(sessionId)
  })
  const gate = new StructuredAgentSessionRestartRestoreGate()
  return {
    restoreReadableSessions: (sessionIds) => gate.run(() => readableRestorer.restore(sessionIds)),
    revealSession: (sessionId) =>
      revealStructuredAgentSession(
        deps,
        sessionId,
        (id) => host.sessions.has(id),
        (id) => readableRestorer.restoreOne(id)
      ),
    eventRecovery: new StructuredAgentSessionEventRecovery({
      deps,
      store: deps.store,
      sessions: host.sessions,
      flushLifecycle: (sessionId) => host.runtimeState.lifecycleBarrier(sessionId),
      publishStatus: (sessionId) => host.subscribers.statusChanged(sessionId),
      publishFence: (sessionId, session) =>
        host.subscribers.snapshot(sessionId, session.journal, session.fence),
      hasResumeCapableHolder: (sessionId) => host.holds.hasResumeCapableHolder(sessionId),
      serialize: (sessionId, task) => host.serialize(sessionId, task),
      now: () => host.now(),
      attachContext: () => host.attachContext(),
      onBarrierError: (sessionId, error) => deps.onEventSinkError?.({ sessionId, error })
    })
  }
}

/** The restart lease reconciler, wired from the host's own probes. */
export function createStructuredAgentSessionHostReconciler(
  deps: StructuredAgentSessionHostDeps,
  host: {
    probeRecord: (
      record: AgentSessionRecord
    ) => ReturnType<Parameters<typeof createRestartReconciler>[0]['probe']>
    now: () => number
  }
): (sessionId: string) => Promise<AgentSessionWireRefusal | null> {
  return createRestartReconciler({
    store: deps.store,
    probe: (record) => host.probeRecord(record),
    ...(deps.probeOwners ? { probeMany: deps.probeOwners } : {}),
    now: host.now
  })
}

/** A subscriber attaching to a history-only session still gets its hub task
 *  publication observed; a read-only restore never owns a provider acquisition. */
export function observeStructuredAgentSessionSubscribe(
  session: StructuredAgentSessionHostSession,
  attachContext: () => StructuredAgentSessionAttachContext,
  sessionId: string
): void {
  if (session.hasProviderChild) {
    return
  }
  observeRestoredTaskPublication(attachContext(), sessionId, {
    ...session,
    hasProviderChild: false,
    acquisitionGeneration: null
  })
}

export async function reconcileStructuredAgentSessionRestart(
  reconcile: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
): Promise<void> {
  const refusal = await reconcile('startup')
  if (refusal) {
    throw new Error(refusal.code)
  }
}
