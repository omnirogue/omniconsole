import type {
  ConsoleExecutionAck,
  ConsoleExecutionObservation,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'
import type { OrchestrationExecutionObservation } from '../../shared/orchestration-execution-observation'
import {
  ConsoleJobJournal,
  type ConsoleJobPublicationRow,
  type ConsoleJobPublicationPayload
} from '../runtime/orchestration/console-job-journal'
import type {
  ConsoleJobResultObservation,
  ConsoleJobResultPublication
} from '../runtime/orchestration/console-job-result'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'

export type ConsoleJobPublisher = (
  observation: ConsoleExecutionObservation,
  expectedPrincipal: string
) => Promise<ConsoleWorkflowResult<ConsoleExecutionAck>>

export type ConsoleJobPublicationOptions = {
  db: OrchestrationDb
  publish: ConsoleJobPublisher
  publishResult?: (
    result: ConsoleJobResultPublication,
    expectedPrincipal: string
  ) => Promise<ConsoleWorkflowResult<ConsoleExecutionAck>>
  getPrincipal: () => Promise<string | null>
  sanitize: (text: string) => string
  warn?: (message: string) => void
  /** Fires only after the console acknowledged this exact retained terminal result. */
  onResultPublished?: (publication: ConsoleJobResultPublication) => void
}

export class ConsoleJobPublication {
  readonly journal: ConsoleJobJournal
  private flushing: Promise<void> | null = null
  private requested = false
  private stopped = false

  constructor(private readonly options: ConsoleJobPublicationOptions) {
    this.journal = new ConsoleJobJournal(options.db, options.sanitize)
  }

  onCommitted(observation: OrchestrationExecutionObservation): void {
    if (this.stopped) {
      return
    }
    this.journal.capture(observation)
    void this.flush()
  }

  onCommittedResult(observation: ConsoleJobResultObservation): void {
    if (this.stopped) {
      return
    }
    this.journal.capture(observation)
    void this.flush()
  }

  flush(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve()
    }
    this.requested = true
    if (!this.flushing) {
      this.flushing = Promise.resolve()
        .then(async () => {
          while (this.requested && !this.stopped) {
            this.requested = false
            this.journal.recover(() =>
              this.warn('A committed job observation could not be queued.')
            )
            await this.drain()
          }
        })
        .catch(() => this.warn('Console job publication is retained for recovery.'))
        .finally(() => {
          this.flushing = null
          if (this.requested && !this.stopped) {
            void this.flush()
          }
        })
    }
    return this.flushing
  }

  async dispose(): Promise<void> {
    this.stopped = true
    await this.flushing
  }

  private async drain(): Promise<void> {
    let sequence = 0
    const blockedJobs = new Set<string>()
    for (;;) {
      const rows = this.journal.pending(sequence)
      for (const row of rows) {
        if (this.stopped) {
          return
        }
        sequence = row.journal_sequence
        const payload = JSON.parse(row.payload) as ConsoleJobPublicationPayload
        const job = JSON.stringify([
          row.principal,
          payload.binding.jobId,
          payload.binding.attempt,
          payload.binding.leaseGeneration
        ])
        if (row.retry_blocked) {
          blockedJobs.add(job)
        }
        if (blockedJobs.has(job)) {
          continue
        }
        if (!(await this.publish(row, payload))) {
          blockedJobs.add(job)
        }
      }
      if (rows.length < 100) {
        return
      }
    }
  }

  private async publish(
    row: ConsoleJobPublicationRow,
    payload: ConsoleJobPublicationPayload
  ): Promise<boolean> {
    try {
      if ((await this.options.getPrincipal()) !== row.principal) {
        this.journal.fail(
          row,
          'Sign in as the person who activated this job to resume publication.'
        )
        return false
      }
      if (this.stopped) {
        return false
      }
      if (this.options.sanitize(row.payload) !== row.payload) {
        this.journal.fail(
          row,
          'Publication is retained because its saved payload requires redaction.'
        )
        return false
      }
      // The transport must check expectedPrincipal against the same credential used by the request.
      const result =
        'result' in payload
          ? await this.options.publishResult?.(payload, row.principal)
          : await this.options.publish(payload, row.principal)
      if (!result) {
        this.journal.fail(
          row,
          'The console does not yet provide durable terminal result acknowledgement.'
        )
        return false
      }
      if (!result.ok) {
        const { status, code } = result.error
        const refused =
          (status !== undefined &&
            status >= 400 &&
            status < 500 &&
            status !== 408 &&
            status !== 429) ||
          ['stale_claim', 'stale_generation', 'forbidden', 'validation'].includes(code)
        this.journal.fail(row, result.error.message, refused)
        this.warn(result.error.message)
        return false
      }
      if (!this.journal.acknowledge(row, result.data)) {
        this.journal.fail(row, 'The console did not acknowledge the exact journal publication.')
        this.warn('The console did not acknowledge the exact journal publication.')
        return false
      }
      if ('result' in payload) {
        // Why guarded: a follow-on reader must never turn an acknowledged result into a failure.
        try {
          this.options.onResultPublished?.(payload)
        } catch {
          this.warn('The published result could not be handed to auto-advance.')
        }
      }
      return true
    } catch {
      this.journal.fail(
        row,
        'The publication response was not confirmed; the same receipt will be retried.'
      )
      this.warn('The publication response was not confirmed; the same receipt will be retried.')
      return false
    }
  }

  private warn(message: string): void {
    try {
      this.options.warn?.(this.options.sanitize(message).slice(0, 1000))
    } catch {
      // Diagnostic callbacks cannot interrupt durable delivery.
    }
  }
}
