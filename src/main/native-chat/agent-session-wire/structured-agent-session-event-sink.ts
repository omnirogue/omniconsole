// Where an adapter writes the provider events it did not synchronously return.
//
// A provider starts streaming the moment its process exists, and that moment is
// INSIDE `adapter.acquire` — before the journal is open and before the host has
// registered the session. So the sink an adapter receives is deferred: writes
// queue in arrival order and drain once the journal exists.
//
// One sink lives for the session, not for one acquisition: a re-attach opens a
// NEW journal object at a NEW fence, and rebinding re-points the same sink at
// it. That keeps a single identity for the adapter to hold across a re-acquire,
// and the adapter closes the superseded child, so nothing writes behind a fence
// that has already moved.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

export type StructuredAgentSessionSinkAdmission =
  | { accepted: true }
  | { accepted: false; reason: 'backpressure' | 'failed' | 'closed' }

export type StructuredAgentSessionSinkState = {
  queuedBytes: number
  queuedOperations: number
  backpressured: boolean
  failed: boolean
}

export type StructuredAgentSessionSinkBarrier = { ok: true } | { ok: false; error: unknown }

export type StructuredAgentSessionAppendOptions = {
  /** Pending checkpoints with this key replace one another before they run. */
  coalescingKey?: string
  /** Marks a critical lifecycle operation for lifecycle barriers and diagnostics. */
  lifecycle?: boolean
  /** OmniConsole: a turn boundary whose durable cursor feeds hub task publication. */
  checkpoint?: 'turn-ended'
}

export type StructuredAgentSessionEventSink = {
  appendItem(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options?: StructuredAgentSessionAppendOptions
  ): void
  appendTombstone(
    identity: AgentJournalItemIdentity,
    options?: StructuredAgentSessionAppendOptions
  ): void
  tryAppendTombstone?(
    identity: AgentJournalItemIdentity,
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  publish(options?: StructuredAgentSessionAppendOptions): void
  tryAppendItem?(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  appendLifecycleBatch?(
    settlementId: string,
    mutations: readonly JournalLifecycleMutationInput[],
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission | void
  tryAppendLifecycleBatch?(
    settlementId: string,
    mutations: readonly JournalLifecycleMutationInput[],
    options?: StructuredAgentSessionAppendOptions
  ): StructuredAgentSessionSinkAdmission
  tryPublish?(options?: StructuredAgentSessionAppendOptions): StructuredAgentSessionSinkAdmission
  /** Couples durable-queue pressure to the exact provider stream producing it. */
  bindReadingControl?(control: StructuredAgentSessionReadingControl): () => void
}

export type StructuredAgentSessionEventTarget = {
  journal: AgentSessionJournal
  /** Fence the sink writes at. Fixed for the life of the sink: a new fence
   *  means a new acquisition, which gets its own sink. */
  fence: number
  publish: () => void
  /** A turn boundary's durable append, never an in-progress token update or exit proof. */
  checkpointWritten?: (cursor: AgentJournalCursor) => void | Promise<void>
}

export type DeferredStructuredAgentSessionEventSink = {
  sink: StructuredAgentSessionEventSink
  bind(target: StructuredAgentSessionEventTarget): void
  unbind(): void
  close(): void
  drained(): Promise<StructuredAgentSessionSinkBarrier>
  lifecycleBarrier(): Promise<StructuredAgentSessionSinkBarrier>
  state(): StructuredAgentSessionSinkState
}

export type StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: number
  maxQueuedBytes: number
  lowQueuedBytes: number
  pauseQueuedOperations: number
  maxQueuedOperations: number
  lowQueuedOperations: number
  maxLifecycleQueuedBytes: number
  maxLifecycleQueuedOperations: number
}

export type StructuredAgentSessionReadingControl = {
  pauseReading(): void
  resumeReading(): void
}

const DEFAULT_WATERMARKS: StructuredAgentSessionSinkWatermarks = {
  pauseQueuedBytes: 16 * 1024 * 1024,
  maxQueuedBytes: 32 * 1024 * 1024,
  lowQueuedBytes: 8 * 1024 * 1024,
  pauseQueuedOperations: 512,
  maxQueuedOperations: 1_024,
  lowQueuedOperations: 256,
  maxLifecycleQueuedBytes: 16 * 1024 * 1024,
  maxLifecycleQueuedOperations: 1_024
}

export function createDeferredStructuredAgentSessionEventSink(
  deps: {
    onError?: (error: unknown) => void
    watermarks?: Partial<StructuredAgentSessionSinkWatermarks>
    readingControl?: StructuredAgentSessionReadingControl
    onBackpressureChange?: (backpressured: boolean, state: StructuredAgentSessionSinkState) => void
  } = {}
): DeferredStructuredAgentSessionEventSink {
  const watermarks = { ...DEFAULT_WATERMARKS, ...deps.watermarks }
  const queue = new StructuredAgentSessionSinkQueue({
    watermarks,
    ...(deps.onError ? { onError: deps.onError } : {}),
    ...(deps.readingControl ? { readingControl: deps.readingControl } : {}),
    ...(deps.onBackpressureChange ? { onBackpressureChange: deps.onBackpressureChange } : {})
  })

  const appendLifecycleBatch = (
    settlementId: string,
    mutations: readonly JournalLifecycleMutationInput[],
    options: StructuredAgentSessionAppendOptions = {}
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit(
      {
        bytes: Buffer.byteLength(JSON.stringify({ settlementId, mutations }), 'utf8') + 512,
        coalescingKey: `lifecycle:${settlementId}`,
        run: async (bound) => {
          const cursor = await bound.journal.appendLifecycleBatch({
            settlementId,
            mutations,
            fence: bound.fence
          })
          // OmniConsole: a batch that retires the turn-lifecycle row is a turn boundary.
          if (options.checkpoint === 'turn-ended') {
            await reportCheckpoint(bound, cursor, deps.onError)
          }
          return cursor
        }
      },
      { ...options, lifecycle: true }
    )

  const publish = (
    options: StructuredAgentSessionAppendOptions = {}
  ): StructuredAgentSessionSinkAdmission =>
    queue.submit(
      {
        bytes: 1,
        coalescingKey: options.coalescingKey ?? 'publish',
        run: (bound) => bound.publish()
      },
      options
    )

  return {
    sink: {
      appendItem: (identity, body, options = {}) => {
        queue.submit(
          {
            bytes: estimateStructuredAgentSessionItemBytes(identity, body),
            coalescingKey: options.coalescingKey,
            run: async (bound) => {
              const receipt = await bound.journal.appendItem(identity, body, {
                fence: bound.fence
              })
              // OmniConsole: a completed turn boundary is the hub task publication
              // point. Reporting is best effort — a reporter that throws must not
              // fail the durable write or latch the sink.
              if (body.kind === 'status' && body.turnLifecycle?.state === 'completed') {
                await reportCheckpoint(bound, receipt.cursor, deps.onError)
              }
              return receipt
            }
          },
          options
        )
      },
      tryAppendItem: (identity, body, options = {}) =>
        queue.submit(
          {
            bytes: estimateStructuredAgentSessionItemBytes(identity, body),
            coalescingKey: options.coalescingKey,
            run: async (bound) => {
              const receipt = await bound.journal.appendItem(identity, body, {
                fence: bound.fence
              })
              // OmniConsole: a completed turn boundary is the hub task publication
              // point. Reporting is best effort — a reporter that throws must not
              // fail the durable write or latch the sink.
              if (body.kind === 'status' && body.turnLifecycle?.state === 'completed') {
                await reportCheckpoint(bound, receipt.cursor, deps.onError)
              }
              return receipt
            }
          },
          options
        ),
      appendLifecycleBatch: (settlementId, mutations, options = {}) => {
        const admission = appendLifecycleBatch(settlementId, mutations, options)
        if (!admission.accepted) {
          deps.onError?.(
            new Error(
              `lifecycle journal batch ${settlementId} rejected by sink ${admission.reason}`
            )
          )
        }
        return admission
      },
      tryAppendLifecycleBatch: appendLifecycleBatch,
      bindReadingControl: (control) => {
        return queue.bindReadingControl(control)
      },
      appendTombstone: (identity, options = {}) => {
        queue.submit(
          {
            bytes: Buffer.byteLength(agentJournalItemKey(identity), 'utf8') + 256,
            run: async (bound) => {
              const cursor = await bound.journal.appendTombstone(identity, { fence: bound.fence })
              // OmniConsole: a turn-ended tombstone is the hub task publication point.
              if (options.checkpoint === 'turn-ended') {
                await reportCheckpoint(bound, cursor, deps.onError)
              }
              return cursor
            }
          },
          options
        )
      },
      tryAppendTombstone: (identity, options = {}) =>
        queue.submit(
          {
            bytes: Buffer.byteLength(agentJournalItemKey(identity), 'utf8') + 256,
            run: async (bound) => {
              const cursor = await bound.journal.appendTombstone(identity, { fence: bound.fence })
              // OmniConsole: a turn-ended tombstone is the hub task publication point.
              if (options.checkpoint === 'turn-ended') {
                await reportCheckpoint(bound, cursor, deps.onError)
              }
              return cursor
            }
          },
          options
        ),
      publish: (options = {}) => {
        publish(options)
      },
      tryPublish: publish
    },
    bind: (next) => queue.bind(next),
    unbind: () => queue.unbind(),
    close: () => queue.close(),
    drained: queue.barrier,
    lifecycleBarrier: queue.barrier,
    state: queue.state
  }
}

/** OmniConsole: hub checkpoint reporting is observational. It runs inside the
 *  serialized sink operation so a flush still waits for it, but its failure is
 *  reported and swallowed — the journal write already landed. */
async function reportCheckpoint(
  bound: StructuredAgentSessionEventTarget,
  cursor: AgentJournalCursor,
  onError?: (error: unknown) => void
): Promise<void> {
  try {
    await bound.checkpointWritten?.(cursor)
  } catch (error) {
    onError?.(error)
  }
}
