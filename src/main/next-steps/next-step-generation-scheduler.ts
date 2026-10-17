/**
 * When a suggester call may run.
 *
 * - A finished turn waits `delayMs` first; the pane going busy again cancels it, even once queued.
 * - One job per conversation: scheduling a newer one aborts the older, wherever it is.
 * - At most `maxConcurrent` calls run at once across every conversation.
 * - One call per lane at a time. The one-shot runner cancels by operation + workspace path, so two
 *   calls in one workspace could not be cancelled apart; the second waits for the first.
 */

export type NextStepGenerationJob = {
  /** The conversation this job answers for. */
  key: string
  /** The runner's cancellation lane (the workspace path on its host). */
  lane: string
  /** Called once the wait ends; false drops the job without running it. */
  admit?: () => boolean
  run: (signal: AbortSignal) => Promise<void>
  /** An admitted job removed before it ran (busy, superseded, pane closed). */
  onDropped?: (reason: string) => void
}

type Entry = { job: NextStepGenerationJob; controller: AbortController }

export type NextStepGenerationSchedulerOptions = {
  delayMs: number
  maxConcurrent: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class NextStepGenerationScheduler {
  private readonly waiting = new Map<string, { job: NextStepGenerationJob; timer: unknown }>()
  private queued: Entry[] = []
  private readonly running = new Set<Entry>()
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: NextStepGenerationSchedulerOptions) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** Replaces any job for the same conversation. `immediate` skips the wait (a person's click). */
  schedule(job: NextStepGenerationJob, options: { immediate?: boolean } = {}): void {
    this.abort(job.key, 'superseded')
    if (options.immediate) {
      this.admit(job)
      return
    }
    const timer = this.setTimer(() => {
      if (this.waiting.get(job.key)?.job === job) {
        this.waiting.delete(job.key)
        this.admit(job)
      }
    }, this.options.delayMs)
    this.waiting.set(job.key, { job, timer })
  }

  /** Cancels a job that has not started: in its wait, or queued behind the cap. True when one was. */
  cancelWaiting(key: string, reason = 'busy'): boolean {
    const waiting = this.waiting.get(key)
    if (waiting) {
      this.clearTimer(waiting.timer)
      this.waiting.delete(key)
    }
    const dropped = this.queued.filter((entry) => entry.job.key === key)
    this.queued = this.queued.filter((entry) => entry.job.key !== key)
    for (const entry of dropped) {
      entry.job.onDropped?.(reason)
    }
    return Boolean(waiting) || dropped.length > 0
  }

  /** Stops the conversation's job wherever it is; a running call is cancelled through its signal. */
  abort(key: string, reason: string): void {
    this.cancelWaiting(key, reason)
    for (const entry of this.running) {
      if (entry.job.key === key && !entry.controller.signal.aborted) {
        entry.controller.abort(reason)
      }
    }
  }

  /** Calls holding a slot, including aborted ones still unwinding their process. */
  get runningCount(): number {
    return this.running.size
  }

  get queuedCount(): number {
    return this.queued.length
  }

  isWaiting(key: string): boolean {
    return this.waiting.has(key)
  }

  private admit(job: NextStepGenerationJob): void {
    if (job.admit && !job.admit()) {
      return
    }
    this.queued.push({ job, controller: new AbortController() })
    this.pump()
  }

  private pump(): void {
    while (this.running.size < this.options.maxConcurrent) {
      const busyLanes = new Set([...this.running].map((entry) => entry.job.lane))
      const index = this.queued.findIndex((entry) => !busyLanes.has(entry.job.lane))
      if (index === -1) {
        return
      }
      const [entry] = this.queued.splice(index, 1)
      this.start(entry!)
    }
  }

  private start(entry: Entry): void {
    this.running.add(entry)
    void entry.job
      .run(entry.controller.signal)
      .catch((error) => console.warn('[next-steps] generation failed', error))
      .finally(() => {
        this.running.delete(entry)
        this.pump()
      })
  }
}
