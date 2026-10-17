import type { AutomationRun } from '../../shared/automations-types'

/** Cadence for re-checking a retained run whose pane has not remounted yet. */
const RETRY_INTERVAL_MS = 2_000
/** Grace after the terminal surface reports ready before an unresolvable run is
 *  called lost. Covers restored-pane remount and SSH/WSL reattach, and matches
 *  the run observer's agent-start deadline. */
const SURFACE_SETTLE_MS = 2 * 60 * 1000

export type RetainedRunReconcilerDeps = {
  /** Attaches a watcher; false while the terminal surface cannot answer yet. */
  attach: (run: AutomationRun) => boolean
  /** Latest persisted run, or null once it reached a terminal status. */
  readRetainedRun: (run: AutomationRun) => AutomationRun | null
  strand: (run: AutomationRun) => void
}

export type RetainedRunReconciliationOptions = { strandUnresolved?: boolean }

/**
 * Startup reconciliation of retained non-terminal runs.
 *
 * Why staged rather than one synchronous pass: at authority startup no window
 * graph has published yet, so "this pane has no terminal" means "not known yet",
 * never "the terminal is gone" — the same positive-evidence rule the design doc
 * applies to ownership. Only a surface that has reported ready and still cannot
 * resolve the pane after a grace window is evidence of a lost run.
 */
export class RetainedRunReconciler {
  private readonly deps: RetainedRunReconcilerDeps
  private readonly pending = new Map<
    string,
    { run: AutomationRun; retainedAt: number; strandUnresolved: boolean }
  >()
  private timer: ReturnType<typeof setInterval> | null = null
  private surfaceReadyAt: number | null = null
  private disposed = false

  constructor(deps: RetainedRunReconcilerDeps) {
    this.deps = deps
  }

  reconcile(runs: readonly AutomationRun[], options: RetainedRunReconciliationOptions = {}): void {
    if (this.disposed) {
      return
    }
    for (const run of runs) {
      if (!this.deps.attach(run)) {
        const previous = this.pending.get(run.id)
        this.pending.set(run.id, {
          run,
          retainedAt: previous?.retainedAt ?? Date.now(),
          strandUnresolved:
            previous?.strandUnresolved !== false && options.strandUnresolved !== false
        })
      }
    }
    this.sweep()
  }

  /** The authority's terminal surface can now answer pane lookups. */
  markSurfaceReady(): void {
    if (this.disposed) {
      return
    }
    this.surfaceReadyAt ??= Date.now()
    this.sweep()
  }

  dispose(): void {
    this.disposed = true
    this.pending.clear()
    this.disarm()
  }

  private sweep(): void {
    // Deleting the current entry mid-iteration is defined for Map; nothing here
    // re-enters the reconciler, so no snapshot is needed.
    for (const [runId, { run, retainedAt, strandUnresolved }] of this.pending) {
      const current = this.deps.readRetainedRun(run)
      if (!current || this.deps.attach(current)) {
        this.pending.delete(runId)
        continue
      }
      // A later renderer reload gets the same reattachment grace as startup.
      const strandAt =
        this.surfaceReadyAt === null
          ? null
          : Math.max(this.surfaceReadyAt, retainedAt) + SURFACE_SETTLE_MS
      if (
        strandUnresolved &&
        current.launchOutcome !== 'unverifiable' &&
        strandAt !== null &&
        Date.now() >= strandAt
      ) {
        this.pending.delete(runId)
        this.deps.strand(current)
      }
    }
    if (this.pending.size === 0) {
      this.disarm()
      return
    }
    this.arm()
  }

  private arm(): void {
    if (this.timer || this.disposed) {
      return
    }
    const timer = setInterval(() => this.sweep(), RETRY_INTERVAL_MS)
    // Why: a pending retry must never be the reason a process stays alive.
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  private disarm(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }
}
