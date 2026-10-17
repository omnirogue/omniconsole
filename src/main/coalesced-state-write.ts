// Why: main-process JSON state files were rewritten tens of times a minute (#857); these bound
// how often a rewrite may start while keeping an occasional edit on disk within about a second.

/** Token bucket: `burst` writes start at once, then one more per `refillMs` under sustained churn. */
export class WriteRateBudget {
  private tokens: number
  private refilledAt: number | null = null

  constructor(
    private readonly burst: number,
    private readonly refillMs: number,
    // Why a closure: fake timers replace the global Date after construction.
    private readonly now: () => number = () => Date.now()
  ) {
    this.tokens = burst
  }

  /** Milliseconds until a write may start; 0 when one may start now. */
  waitMs(now = this.now()): number {
    this.refill(now)
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * this.refillMs)
  }

  /** Record a write; a forced one (quit, durability barrier) past an empty budget floors at zero. */
  consume(now = this.now()): void {
    this.refill(now)
    this.tokens = Math.max(0, this.tokens - 1)
  }

  private refill(now: number): void {
    if (this.refilledAt !== null && now > this.refilledAt) {
      this.tokens = Math.min(this.burst, this.tokens + (now - this.refilledAt) / this.refillMs)
    }
    this.refilledAt = now
  }
}

/** Trailing debounce capped by max-wait, then held back until the rate budget allows a write. */
export function coalescedWriteDelay(input: {
  now: number
  firstPendingAt: number
  debounceMs: number
  maxWaitMs: number
  budgetWaitMs: number
}): number {
  const untilMaxWait = Math.max(0, input.firstPendingAt + input.maxWaitMs - input.now)
  return Math.max(Math.min(input.debounceMs, untilMaxWait), input.budgetWaitMs)
}

export type CoalescedWriteTiming = {
  debounceMs: number
  maxWaitMs: number
  burst: number
  refillMs: number
}

/** Coalesces `schedule()` bursts into one `write()`; `flush()` runs a pending write now (quit path). */
export class CoalescedWrite {
  private timer: ReturnType<typeof setTimeout> | null = null
  private firstPendingAt: number | null = null
  private readonly budget: WriteRateBudget

  constructor(
    private readonly timing: CoalescedWriteTiming,
    private readonly write: () => void,
    private readonly now: () => number = () => Date.now()
  ) {
    this.budget = new WriteRateBudget(timing.burst, timing.refillMs, now)
  }

  get pending(): boolean {
    return this.firstPendingAt !== null
  }

  schedule(): void {
    const now = this.now()
    this.firstPendingAt ??= now
    if (this.timer) {
      clearTimeout(this.timer)
    }
    const delay = coalescedWriteDelay({
      now,
      firstPendingAt: this.firstPendingAt,
      debounceMs: this.timing.debounceMs,
      maxWaitMs: this.timing.maxWaitMs,
      budgetWaitMs: this.budget.waitMs(now)
    })
    this.timer = setTimeout(() => this.flush(), delay)
    // Why: never keep the process alive for a state write; quit flushes explicitly.
    this.timer.unref?.()
  }

  flush(): void {
    if (!this.pending) {
      return
    }
    this.cancel()
    this.budget.consume()
    this.write()
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.firstPendingAt = null
  }
}
