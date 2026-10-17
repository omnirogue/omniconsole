import type { OrchestrationCheckOutput } from '../../../shared/orchestration-check-output'
import { applyDeliveryToTarget } from './build-review-messages'
import type { WorkerUnitRegistry } from './build-review-worker-registry'
import {
  assertNotCancelled,
  assertWorkerAlive,
  CancelledError,
  WORKER_CHECK_TYPES,
  type ActiveRun,
  type WorkerHostContext,
  type WorkerLifecycleContext
} from './build-review-worker-lifecycle'

/**
 * What watches for a worker that finished without saying so. The pump owns the only
 * empty-window signal in a Run, so the watch is driven from here; what it does with
 * that signal is not the mailbox's business.
 */
export type WorkerStallWatch = {
  /** A batch was folded: whatever these workers are, they are not silently stalled. */
  onMessages: () => void
  /** A whole window passed with nothing new said. */
  onEmptyWindow: () => Promise<void>
}

const WAIT_WINDOW_MS = 60_000
/** A replayed Delivery returns immediately; without this the loop would spin hot. */
const REPLAY_BACKOFF_MS = 250

/**
 * The one mailbox reader a Run is allowed to have.
 *
 * A Run has a single outstanding Delivery and `check --wait` is an exclusive waiter:
 * a second concurrent wait is refused with `waiter_exists`. So parallel workers
 * cannot each block on their own check. This pump runs one wait loop, applies every
 * message to the registry by `payload.dispatchId`, and resolves the per-worker
 * promises. The Delivery it read is acknowledged once per batch by the runner, after
 * the workers in that batch have been released.
 */
export class RunMailboxPump {
  private loop: Promise<void> | null = null
  private stopped = false
  private waiting: AbortController | null = null

  constructor(
    private readonly ctx: WorkerLifecycleContext,
    private readonly host: WorkerHostContext,
    private readonly run: ActiveRun,
    private readonly registry: WorkerUnitRegistry,
    private readonly stallWatch?: WorkerStallWatch
  ) {}

  /** Start the wait loop if it is not already running. Safe to call after every start. */
  ensure(): void {
    if (this.loop || this.stopped) {
      return
    }
    this.loop = this.pump()
      .then(
        () => true,
        (error: unknown) => {
          // Nobody else can settle those promises, so the failure has to reach them.
          this.registry.fail(error instanceof Error ? error : new Error(String(error)))
          return false
        }
      )
      .then((exitedCleanly) => {
        this.loop = null
        // Why: a worker bound while the loop was exiting called ensure() too early to start one.
        if (exitedCleanly && !this.stopped && this.registry.live().length > 0) {
          this.ensure()
        }
      })
  }

  /**
   * Cut the current wait window short. A batch whose workers all died WITHOUT
   * reporting (a start that failed after its dispatch existed) leaves the loop
   * blocked on a mailbox nobody will write to; without this the runner would sit
   * out the whole window before noticing.
   */
  wake(): void {
    this.waiting?.abort()
  }

  /** Wait for the current loop to finish; it exits when no worker is live. */
  async idle(): Promise<void> {
    await this.loop
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.loop?.catch(() => undefined)
  }

  private async pump(): Promise<void> {
    while (this.registry.live().length > 0 && !this.stopped) {
      assertNotCancelled(this.run)
      // A per-read controller so `wake()` can end one window without cancelling
      // the Run; a Run cancel still reaches it through this listener.
      const waiting = new AbortController()
      const cancelRun = () => waiting.abort()
      this.run.abort.signal.addEventListener('abort', cancelRun, { once: true })
      this.waiting = waiting
      let delivery: OrchestrationCheckOutput
      try {
        delivery = await this.ctx.call<OrchestrationCheckOutput>(
          'orchestration.check',
          {
            terminal: this.host.coordinatorTerminalHandle,
            run: this.host.runId ?? undefined,
            wait: true,
            types: WORKER_CHECK_TYPES,
            timeoutMs: WAIT_WINDOW_MS,
            // Why: the previous batch is acknowledged by piggyback on this read, so
            // the Run never holds two outstanding Deliveries. The acknowledgement is
            // applied before the wait, so a woken read still settles it.
            ...(this.run.pendingAck ? { ack: this.run.pendingAck } : {})
          },
          { signal: waiting.signal }
        )
      } catch (error) {
        if (this.run.abort.signal.aborted) {
          throw new CancelledError()
        }
        if (!waiting.signal.aborted) {
          throw error
        }
        this.run.pendingAck = null
        continue
      } finally {
        this.run.abort.signal.removeEventListener('abort', cancelRun)
        this.waiting = null
      }
      if (this.run.abort.signal.aborted) {
        throw new CancelledError()
      }
      this.run.pendingAck = delivery.deliveryId ?? null
      // Why: a Delivery replays until acknowledged, so a batch seen again after a
      // failed ack must not be folded twice.
      const fresh = delivery.messages.filter((message) => !this.run.seenMessageIds.has(message.id))
      for (const message of fresh) {
        this.run.seenMessageIds.add(message.id)
      }
      if (fresh.length > 0) {
        applyDeliveryToTarget(this.registry.asMailboxTarget(this.host.log), fresh)
        this.stallWatch?.onMessages()
        this.host.changed()
        this.registry.notify()
        continue
      }
      // Nothing NEW was said. Either the wait window expired or an unacknowledged
      // Delivery replayed; in both cases a worker may have died without reporting,
      // and a replay that returns instantly must not become a hot loop.
      //
      // Why the stall watch runs FIRST: a worker that finished its work and then went
      // idle has produced everything it was asked for, and reading that off disk must
      // not lose a race with a liveness probe that would fail it instead. And why only
      // on a TRULY empty read: a replay returns instantly, and counting those as
      // windows would turn "idle across two 60 s windows" into "idle for half a
      // second" — the moment between an agent's tool calls.
      if (delivery.messages.length === 0) {
        await this.stallWatch?.onEmptyWindow()
      }
      await this.assertLiveWorkersAlive()
      if (delivery.messages.length > 0) {
        await this.backoff()
      }
    }
  }

  private backoff(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, REPLAY_BACKOFF_MS)
      this.run.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * An empty wait window means nothing was said. A worker that died without
   * reporting would otherwise hold the whole Run open, so each live one is checked.
   */
  private async assertLiveWorkersAlive(): Promise<void> {
    for (const worker of this.registry.live()) {
      try {
        await assertWorkerAlive(this.ctx, this.host, worker)
      } catch {
        // assertWorkerAlive already marked and logged the worker; the runner reads
        // its status. One dead worker must not stop the pump for its siblings.
        this.registry.notify()
      }
    }
  }
}
