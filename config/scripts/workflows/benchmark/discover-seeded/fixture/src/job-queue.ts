import { newId, type Table } from './db'

export type Job = {
  id: string
  kind: string
  payload: unknown
  attempts: number
  runAt: number
}

export type JobHandler = (job: Job) => Promise<void>

/** Delay before the nth retry: 1s, 2s, 4s … capped at five minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, attempts - 1))
}

/**
 * Background jobs (emails, webhooks, reservation sweeps) with a concurrency limit. Every job is
 * journaled before it runs, so a restart picks up what was in flight; a job that keeps failing
 * is retried with backoff and handed to `onDead` after its last attempt.
 */
export class JobQueue {
  private readonly pending: Job[] = []
  private readonly handlers = new Map<string, JobHandler>()
  private active = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly journal: Table<Job>,
    private readonly concurrency: number,
    private readonly maxAttempts = 5,
    private readonly onDead: (job: Job, error: unknown) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler)
  }

  /** Loads journaled jobs after a restart and starts polling for due ones. */
  async start(pollMs = 1_000): Promise<void> {
    for (const job of await this.journal.list()) {
      this.pending.push(job)
    }
    this.timer = setInterval(() => this.pump(), pollMs)
    this.pump()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  async enqueue(kind: string, payload: unknown, delayMs = 0): Promise<Job> {
    const job: Job = { id: newId('job'), kind, payload, attempts: 0, runAt: this.now() + delayMs }
    await this.journal.put(job.id, job)
    this.pending.push(job)
    this.pump()
    return job
  }

  stats(): { pending: number; active: number } {
    return { pending: this.pending.length, active: this.active }
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const now = this.now()
      const index = this.pending.findIndex((job) => job.runAt <= now)
      if (index === -1) {
        return
      }
      const [job] = this.pending.splice(index, 1)
      void this.run(job!)
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.kind)
    if (!handler) {
      this.onDead(job, new Error(`No handler for ${job.kind}`))
      return
    }
    const attempt: Job = { ...job, attempts: job.attempts + 1 }
    await this.journal.put(job.id, attempt)
    this.active += 1
    await handler(attempt).then(
      async () => {
        await this.journal.delete(job.id)
      },
      async (error: unknown) => {
        if (attempt.attempts >= this.maxAttempts) {
          await this.journal.delete(job.id)
          this.onDead(attempt, error)
          return
        }
        const retry = { ...attempt, runAt: this.now() + retryDelayMs(attempt.attempts) }
        await this.journal.put(job.id, retry)
        this.pending.push(retry)
      }
    )
    this.active -= 1
    this.pump()
  }
}
