import {
  LEDGER_BATCH_MAX_BYTES,
  type LedgerBatchEnvelope,
  type LedgerEvent,
  type LedgerEventBatch,
  type LedgerEventDetail,
  type LedgerEventKind
} from '../../shared/session-ledger-contract'
import { settleWithinMs } from '../quit-teardown-deadline'
import { batchKey, LedgerPendingBatches, type QueuedBatch } from './ledger-pending-batches'
import { byteLength, PRESERVED_KINDS, type LedgerSpillStore } from './ledger-spill-file'
import { LedgerSpillJournal } from './ledger-spill-journal'
import { deliverBatch } from './ledger-batch-delivery'

export type { LedgerSpillStore } from './ledger-spill-file'

export type LedgerSendFailureReason =
  | 'offline'
  | 'signed-out'
  | 'unavailable'
  | 'rejected'
  | 'principal-mismatch'
export type LedgerSendResult = { ok: true } | { ok: false; reason: LedgerSendFailureReason }

export type LedgerEventQueueDeps = {
  /** `account` is the batch's immutable binding; the sender must refuse any other bearer. */
  send(batch: LedgerEventBatch, account: string): Promise<LedgerSendResult>
  /** The signed-in principal's stable id (null when signed out); each batch is bound to it and
   *  only ever sent while that same account is signed in. */
  principal?: () => string | null
  /**
   * Whether a batch queued before any principal resolved belongs to `account`: true binds it
   * to that account, false keeps holding it. Absent, ownerless batches are held forever.
   */
  claimOwner?: (
    envelope: Pick<LedgerBatchEnvelope, 'ledger_id' | 'attempt_id'>,
    account: string
  ) => boolean
  /** Whether the row still exists here; an ownerless batch of a row that does not is an orphan. */
  rowKnown?: (envelope: Pick<LedgerBatchEnvelope, 'ledger_id' | 'attempt_id'>) => boolean
  spill?: LedgerSpillStore | null
  warn?: (message: string) => void
  now?: () => number
}

export const LEDGER_FLUSH_INTERVAL_MS = 15_000
export const LEDGER_WARN_INTERVAL_MS = 10 * 60_000
export const LEDGER_TEARDOWN_BUDGET_MS = 2_000
const RETRY_MIN_MS = 30_000
const RETRY_MAX_MS = 5 * 60_000
/** A console 4xx is retried this many times (with backoff) before the batch is given up, loudly. */
export const LEDGER_REJECTED_MAX_ATTEMPTS = 3
/** An ownerless batch nobody could claim in this long is given up, loudly. */
export const LEDGER_OWNERLESS_MAX_AGE_MS = 24 * 60 * 60_000

/** Flushed the moment they are queued: the row's existence and its end must not wait a batch. */
const IMMEDIATE_KINDS: ReadonlySet<LedgerEventKind> = PRESERVED_KINDS

/**
 * Bounded, fire-and-forget event delivery for the session ledger (contract §8).
 * Nothing here throws to a caller and nothing awaits the network on the caller's path.
 */
export class LedgerEventQueue {
  private readonly pending = new LedgerPendingBatches()
  private readonly seqByAttempt = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  /** Batches taken out of `pending` for the send in progress. */
  private sending: QueuedBatch[] = []
  private flushAgain = false
  private retryAt = 0
  /** One immediate-class event may cut the backoff short; after that, starts and stops wait with the rest until a send succeeds. */
  private backoffBypassed = false
  /** Bumped whenever `pending` changes; the spill is rewritten only when it is behind. */
  private revision = 0
  private spilledRevision = -1
  private retryDelayMs = RETRY_MIN_MS
  private lastWarnAt = -Infinity
  private stopped = false
  private readonly now: () => number
  private readonly principal: () => string | null
  private readonly spill: LedgerSpillJournal

  constructor(private readonly deps: LedgerEventQueueDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.principal = deps.principal ?? (() => null)
    this.spill = new LedgerSpillJournal(deps.spill, (message) => this.warn(message))
  }

  pendingEventCount(): number {
    return this.pending.eventCount()
  }

  /**
   * Queue one event under its row; returns the seq it was given. `account` is the row's
   * binding (its owner); it defaults to the signed-in principal, null when nobody is.
   */
  enqueue(
    envelope: LedgerBatchEnvelope,
    event: LedgerEventDetail & { at?: string },
    account: string | null = this.currentAccount()
  ): number {
    const key = batchKey(envelope, account)
    const seqKey = batchKey(envelope, null)
    const seq = (this.seqByAttempt.get(seqKey) ?? 0) + 1
    this.seqByAttempt.set(seqKey, seq)
    const queued: LedgerEvent = {
      seq,
      kind: event.kind,
      detail: event.detail,
      at: event.at ?? new Date(this.now()).toISOString()
    } as LedgerEvent
    try {
      this.pending.append(key, account, envelope, queued, this.now())
      this.revision += 1
      if (IMMEDIATE_KINDS.has(event.kind) && this.now() < this.retryAt && !this.backoffBypassed) {
        // Why: contract §8 — a start or stop ships now, not minutes later; one attempt per
        // backoff window, and a failure hands back to the normal backoff.
        this.backoffBypassed = true
        this.retryAt = 0
        void this.flush()
      } else if (
        IMMEDIATE_KINDS.has(event.kind) ||
        byteLength(this.pending.get(key)) >= LEDGER_BATCH_MAX_BYTES
      ) {
        void this.flush()
      } else {
        this.schedule(LEDGER_FLUSH_INTERVAL_MS)
      }
    } catch (error) {
      this.warn(`queue error: ${error instanceof Error ? error.message : String(error)}`)
    }
    return seq
  }

  /**
   * Move the last run's spill into memory and try to deliver it. The file is rewritten from
   * the merged state (atomically) before anything is sent, never removed first: a crash in
   * between leaves the held batches on disk.
   */
  async drainSpill(): Promise<void> {
    const loaded = this.spill.load()
    if (loaded.state !== 'ok') {
      return
    }
    const { batches } = loaded
    for (const { account, batch, heldSince } of batches) {
      const { events, ...envelope } = batch
      const key = batchKey(envelope, account)
      const existing = this.pending.get(key)
      if (existing) {
        existing.events.unshift(...events)
      } else {
        const since = heldSince ? Date.parse(heldSince) : Number.NaN
        this.pending.set(key, {
          account,
          envelope,
          events: [...events],
          ...(account === null ? { heldSince: Number.isFinite(since) ? since : this.now() } : {})
        })
      }
      this.revision += 1
      // Why: a resumed attempt id never recurs, but keep seq monotonic if one ever does.
      const seqKey = batchKey(envelope, null)
      const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0)
      this.seqByAttempt.set(seqKey, Math.max(this.seqByAttempt.get(seqKey) ?? 0, maxSeq))
    }
    if (batches.length === 0) {
      this.spill.remove()
      return
    }
    this.writeSpill()
    await this.flush()
  }

  /** Deliver everything pending; failures keep the events and spill them to disk. */
  flush(): Promise<void> {
    if (this.inFlight) {
      this.flushAgain = true
      return this.inFlight
    }
    this.clearTimer()
    this.inFlight = this.run().finally(() => {
      this.inFlight = null
      if (this.flushAgain && !this.stopped) {
        this.flushAgain = false
        void this.flush()
      }
    })
    return this.inFlight
  }

  /** Quit path: whatever is not delivered within the budget is spilled and left for next start. */
  async shutdown(budgetMs = LEDGER_TEARDOWN_BUDGET_MS): Promise<void> {
    this.stopped = true
    this.clearTimer()
    // Why: stops enqueued while a run was in flight (every live pane but the first) only set
    // `flushAgain`, which nothing honours once stopped; one more run after the in-flight one
    // settles sends them, all inside the budget.
    const attempt = (this.inFlight ?? Promise.resolve()).then(() =>
      this.pending.size > 0 ? this.run() : undefined
    )
    await settleWithinMs(attempt, budgetMs)
    // Why: whether the send timed out or is still backing off, what is left must survive the quit.
    if (this.pending.size > 0 || this.sending.length > 0) {
      this.writeSpill(true)
    }
  }

  private currentAccount(): string | null {
    try {
      return this.principal() || null
    } catch {
      return null
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.stopped) {
      return
    }
    const wait = Math.max(delayMs, this.retryAt - this.now())
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, wait)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async run(): Promise<void> {
    if (this.pending.size === 0) {
      return
    }
    if (this.now() < this.retryAt) {
      this.schedule(this.retryAt - this.now())
      return
    }
    // Why: a batch queued under one account is never uploaded under another. Ownerless batches
    // (queued before sign-in resolved) bind to the principal only when the row is theirs;
    // otherwise they, like another person's batches, stay held (contract §0b.11).
    const current = this.currentAccount()
    this.discardOrphans()
    const claim = this.deps.claimOwner
    if (current && claim) {
      this.pending.bindOwnerless(current, (envelope) => {
        try {
          return claim(envelope, current)
        } catch {
          return false
        }
      })
    }
    const taken = this.pending.takeForAccount(current)
    // Why: `sending` is everything taken out of `pending` and not yet delivered — including
    // what a failed send left over — so a quit spill written mid-run misses nothing.
    this.sending = taken.batches.map(([, batch]) => batch)
    let failed = false
    const requeueFront: [string, QueuedBatch][] = []
    const requeueBack: [string, QueuedBatch][] = []
    for (const [key, batch] of taken.batches) {
      const outcome = failed
        ? { reason: 'unavailable' as const, remaining: batch.events }
        : await deliverBatch(batch, {
            send: this.deps.send,
            currentAccount: () => this.currentAccount(),
            warn: (message) => this.warn(message)
          })
      if (!outcome) {
        this.sending = this.sending.filter((entry) => entry !== batch)
        continue
      }
      const rest: QueuedBatch = { ...batch, events: outcome.remaining }
      this.sending = this.sending.map((entry) => (entry === batch ? rest : entry))
      if (outcome.reason === 'rejected') {
        // Why: a 4xx is about this body, not the transport: it never blocks other rows'
        // batches or starts a backoff. It gets a few retries behind everything else and is
        // then given up — never silently.
        rest.rejections = (batch.rejections ?? 0) + 1
        if (rest.rejections >= LEDGER_REJECTED_MAX_ATTEMPTS) {
          this.sending = this.sending.filter((entry) => entry !== rest)
          this.warn(
            `batch rejected by the console ${rest.rejections} times; giving up ` +
              `(${rest.envelope.ledger_id}/${rest.envelope.attempt_id}, ` +
              `${rest.events.map((event) => event.kind).join(',')})`,
            true
          )
          continue
        }
        requeueBack.push([key, rest])
        continue
      }
      // Why: a principal mismatch is still that account's batch — it waits, bound, until that
      // person is signed in again; anything else is the transport failing for everyone.
      if (outcome.reason !== 'principal-mismatch') {
        failed = true
      }
      requeueFront.push([key, rest])
    }
    this.pending.requeueFrontInOrder(requeueFront)
    for (const [key, batch] of requeueBack) {
      this.pending.requeueBack(key, batch)
    }
    if (requeueFront.length > 0 || requeueBack.length > 0 || taken.batches.length > 0) {
      this.revision += 1
    }
    this.sending = []
    if (failed) {
      this.retryAt = this.now() + this.retryDelayMs
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_MS)
      this.writeSpill()
      this.warn('delivery failed; events kept for retry')
      this.schedule(this.retryDelayMs)
      return
    }
    this.retryDelayMs = RETRY_MIN_MS
    this.retryAt = 0
    this.backoffBypassed = false
    if (this.pending.size === 0) {
      // Why: only a fully delivered queue may drop the disk copy — and never after shutdown,
      // when the quit spill is the record of what may not have arrived (a duplicate is
      // ignored by seq, a lost stop is a ghost).
      if (!this.stopped) {
        this.spill.remove()
      }
      return
    }
    // Why: whatever is still undelivered — held for another account, or refused and retried
    // later — outlives this run on disk; rewritten only when something changed.
    if (this.revision !== this.spilledRevision) {
      this.writeSpill()
    }
    this.schedule(LEDGER_FLUSH_INTERVAL_MS)
  }

  private writeSpill(includeInFlight = false): void {
    this.spilledRevision = this.revision
    this.spill.save(
      includeInFlight ? [...this.sending, ...this.pending.values()] : this.pending.values(),
      this.currentAccount()
    )
  }

  /** Ownerless batches nobody can ever claim are given up, once and loudly, so they cannot pin the queue. */
  private discardOrphans(): void {
    const removed = this.pending.discardOrphans(
      this.deps.rowKnown,
      this.now() - LEDGER_OWNERLESS_MAX_AGE_MS
    )
    if (removed > 0) {
      this.revision += 1
      this.warn(`${removed} ownerless batch(es) had no row to belong to; given up`, true)
    }
  }

  private warn(message: string, always = false): void {
    const at = this.now()
    if (!always && at - this.lastWarnAt < LEDGER_WARN_INTERVAL_MS) {
      return
    }
    this.lastWarnAt = at
    ;(this.deps.warn ?? ((text: string) => console.warn(`[session-ledger] ${text}`)))(message)
  }
}
