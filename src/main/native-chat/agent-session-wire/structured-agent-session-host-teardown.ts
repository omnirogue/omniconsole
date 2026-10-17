import type { StructuredAgentSessionHolds } from './structured-agent-session-holds'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHostHandoff } from './structured-agent-session-host-handoff'
import type { StructuredAgentSessionTaskQueue } from './structured-agent-session-task-queue'
// Host teardown, made failure-complete.
//
// A trailing "close every journal" statement is skipped on exactly the path
// that leaks: `flushAllEventSinks` throws BY DESIGN when a sink barrier fails,
// and the attach drain can reject too. Every connection would then be left open
// with the global runtime reference already cleared — the one state from which
// nothing can ever close them.

import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export type StructuredAgentSessionTeardownPhase = {
  name: string
  run: () => Promise<void> | void
}

/**
 * Close out every session that still has a provider child, and report EVERY
 * failure rather than the first.
 *
 * Lives here rather than on the host class for the reason the rest of this
 * module does: it is shutdown ordering, not part of the host's serving surface,
 * and the class is at its line budget. OmniConsole: these sessions carry hub
 * task publications, so runtime stop runs this BEFORE the host lets go of its
 * journals.
 */
export async function closeNativeStructuredAgentSessions(
  sessions: ReadonlyMap<string, Pick<StructuredAgentSessionHostSession, 'hasProviderChild'>>,
  close: (sessionId: string) => Promise<void>
): Promise<void> {
  const errors: unknown[] = []
  const ids = [...sessions].filter(([, session]) => session.hasProviderChild).map(([id]) => id)
  await mapWithConcurrency(ids, 4, async (id) => {
    try {
      await close(id)
    } catch (error) {
      errors.push(error)
    }
  })
  if (errors.length) {
    throw new AggregateError(errors, 'Native session closeout failed during shutdown.')
  }
}

export async function tearDownStructuredAgentSessionHost(input: {
  phases: readonly StructuredAgentSessionTeardownPhase[]
  sessions: Map<string, StructuredAgentSessionHostSession>
}): Promise<void> {
  const failures: unknown[] = []
  for (const phase of input.phases) {
    try {
      await phase.run()
    } catch (error) {
      failures.push(error)
    }
  }

  const entries = [...input.sessions.entries()]
  // `allSettled`, so one rejected close cannot skip the others.
  const closed = await Promise.allSettled(entries.map(([, session]) => session.journal.close()))
  closed.forEach((result, index) => {
    const sessionId = entries[index]?.[0]
    if (result.status === 'fulfilled') {
      // Only a FULFILLED close drops the entry. One that rejected stays indexed,
      // which is what makes a later close a real retry rather than a no-op.
      if (sessionId !== undefined) {
        input.sessions.delete(sessionId)
      }
      return
    }
    failures.push(result.reason)
  })

  // Journals an earlier failure path could not close are retried HERE, which is
  // the only place that owns them once their caller has unwound.
  failures.push(...(await agentSessionJournalCloseRetries.retryAll()))

  if (failures.length > 0) {
    throw new AggregateError(failures, 'agent session host teardown failed')
  }
}

export function flushStructuredSessionHost(input: {
  holds: StructuredAgentSessionHolds
  runtimeState: StructuredAgentSessionHostRuntimeState
  handoffs: StructuredAgentSessionHostHandoff
  tasks: StructuredAgentSessionTaskQueue
  sessions: Map<string, StructuredAgentSessionHostSession>
}): Promise<void> {
  return tearDownStructuredAgentSessionHost({
    phases: [
      { name: 'dispose-holds', run: () => input.holds.dispose() },
      { name: 'stop-lease-renewal', run: () => input.runtimeState.stopLeaseRenewal() },
      { name: 'stop-tui-catchup', run: () => input.handoffs.stopTuiHistoryCatchup() },
      { name: 'drain-attaches', run: () => input.tasks.drainAttaches() },
      { name: 'flush-event-sinks', run: () => input.runtimeState.flushAllEventSinks() }
    ],
    sessions: input.sessions
  })
}
