// Step 3(a), recovery first: the owner reconciles its session-tab inventory at headless startup and
// on desktop/headless transitions, one run at a time. A run that a newer request overtook while it
// awaited the PTY census does not commit; the queued run commits fresher state instead. Readers may
// wait for a pending run to settle, and completeness is advertised only after it does.

export type SessionInventoryReconcileRun = {
  readonly reasons: readonly string[]
  /** False once a newer request arrived after this run started; such a run must not commit. */
  isCurrent(): boolean
}

export class SessionInventoryReconciler {
  private requestSequence = 0
  private settledSequence = 0
  private queued: { promise: Promise<void>; reasons: string[] } | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly reconcile: (run: SessionInventoryReconcileRun) => Promise<void>) {}

  /** Coalesces into the queued run when one has not started yet; otherwise queues a new run. */
  request(reason: string): Promise<void> {
    this.requestSequence += 1
    if (this.queued) {
      this.queued.reasons.push(reason)
      return this.queued.promise
    }
    const reasons = [reason]
    const promise = this.tail.then(async () => {
      this.queued = null
      const startSequence = this.requestSequence
      try {
        await this.reconcile({
          reasons,
          isCurrent: () => this.requestSequence === startSequence
        })
      } finally {
        this.settledSequence = Math.max(this.settledSequence, startSequence)
      }
    })
    this.queued = { promise, reasons }
    this.tail = promise.catch(() => {})
    return promise
  }

  isSettled(): boolean {
    return this.settledSequence === this.requestSequence
  }

  /**
   * Resolves once the latest requested run settled (not merely the one in flight), or after
   * `timeoutMs` when given, so a read never hangs on a stuck census.
   */
  async whenSettled(timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs
    while (!this.isSettled()) {
      if (deadline === null) {
        await this.tail
        continue
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        this.tail,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining)
        })
      ])
      clearTimeout(timer)
    }
  }
}
