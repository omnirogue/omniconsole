import type { EvolveRunRecord } from '../../../shared/evolve-workflow'
import {
  applyEvolveHostedEvent,
  emptyEvolveHostedProgress,
  type EvolveHostedProgress
} from '../../../shared/evolve-hosted-progress'
import { pushEvolveEvent } from './evolve-run-progress'
import type { EvolveFollowContext } from './evolve-service-follow'
import { streamHostedEvolveEvents, type HostedEvolveStreamEnd } from './hosted-evolve-events'

const STREAM_RETRY_MS = 5_000
// After this many failed connects in a row the run is followed by polling alone.
const MAX_STREAM_FAILURES = 3
// Replayed history arrives in bursts; one save and push per window, not per event.
const FLUSH_MS = 250
const HEALTHY_MS = 60_000

export type EvolveHostedStreamDeps = {
  hostedStreamRetryMs?: number
  hostedStreamFlushMs?: number
  /** Off: hosted runs are followed by polling only. */
  hostedEventStream?: boolean
}

export type EvolveHostedStreamFollower = { close: () => void }

function progressOf(record: EvolveRunRecord, at: string): EvolveHostedProgress {
  record.hostedProgress ??= emptyEvolveHostedProgress(at, 'polling')
  return record.hostedProgress
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Streams a hosted run's events into `record.hostedProgress` while it runs. Polling keeps going
 * beside it (the stream has no completion event), so a dropped stream only loses liveness.
 */
export function followHostedEvolveEvents(
  ctx: EvolveFollowContext,
  id: string
): EvolveHostedStreamFollower {
  const controller = new AbortController()
  const { signal } = controller
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    flushTimer = undefined
    const record = ctx.runs.get(id)
    if (record) {
      ctx.changed(record)
    }
  }
  const schedule = () => {
    flushTimer ??= setTimeout(flush, ctx.deps.hostedStreamFlushMs ?? FLUSH_MS)
  }
  const live = () => {
    const record = ctx.runs.get(id)
    return !signal.aborted && record?.state === 'running' && record.cloudRunId ? record : undefined
  }

  const run = async () => {
    let failures = 0
    let why = 'it kept closing without events'
    for (let record = live(); record; record = live()) {
      const progress = progressOf(record, ctx.at())
      let openedAt: number | undefined
      let received = false
      let end: HostedEvolveStreamEnd | undefined
      try {
        end = await streamHostedEvolveEvents(
          record.cloudRunId!,
          {
            lastEventId: progress.lastEventId,
            signal,
            onOpen: () => {
              openedAt = Date.now()
              progress.transport = 'stream'
              schedule()
            },
            onEvent: (event) => {
              received = true
              applyEvolveHostedEvent(progress, event, ctx.at())
              schedule()
            }
          },
          ctx.deps.hosted
        )
      } catch (error) {
        if (signal.aborted) {
          return
        }
        why = error instanceof Error ? error.message : String(error)
      }
      // A stream that delivered or stayed up was healthy; an instant empty end counts as a failure.
      const healthy = received || (openedAt !== undefined && Date.now() - openedAt >= HEALTHY_MS)
      failures = healthy ? 0 : failures + 1
      if (healthy && (end === 'token_expired' || end === 'resync')) {
        continue
      }
      progress.transport = 'polling'
      schedule()
      if (failures >= MAX_STREAM_FAILURES) {
        pushEvolveEvent(
          record,
          `Live progress stream unavailable (${why}); following by polling.`,
          ctx.at()
        )
        return
      }
      await wait(ctx.deps.hostedStreamRetryMs ?? STREAM_RETRY_MS, signal)
    }
  }

  if (ctx.deps.hostedEventStream !== false) {
    void run().finally(() => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flush()
      }
    })
  }
  return { close: () => controller.abort() }
}
