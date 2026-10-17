import { createHash } from 'node:crypto'
import type {
  ConsoleExecutionAck,
  ConsoleExecutionObservation
} from '../../../shared/console-workflow-types'
import type { OrchestrationExecutionObservation } from '../../../shared/orchestration-execution-observation'
import { getConsoleJobBinding, getConsoleJobBindingForDispatch } from './console-job-binding'
import type { OrchestrationDb } from './db/orchestration-db'
import { restoreHubExecutionObservation } from './hub-execution-observation'
import type { MessageRow } from './types'
import {
  restoreConsoleJobResult,
  type ConsoleJobResultObservation,
  type ConsoleJobResultPublication
} from './console-job-result'

export type ConsoleJobPublicationPayload = ConsoleExecutionObservation | ConsoleJobResultPublication

export type ConsoleJobPublicationRow = {
  observation_id: string
  journal_sequence: number
  idempotency_key: string
  principal: string
  payload: string
  acknowledged_at: string | null
  retry_blocked: number
  last_error: string | null
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class ConsoleJobJournal {
  constructor(
    readonly db: OrchestrationDb,
    private readonly sanitize: (text: string) => string
  ) {}

  capture(observation: OrchestrationExecutionObservation | ConsoleJobResultObservation): void {
    const match = /^orchestration:(run_[A-Za-z0-9_-]+):messages:([1-9][0-9]*)$/.exec(
      observation.journalCursor
    )
    if (!match || match[1] !== observation.runId) {
      throw new Error('Only a committed orchestration journal cursor can be published.')
    }
    // BEGIN refuses a caller's uncommitted transaction; publication cannot escape its rollback.
    this.db.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.db
        .prepare('SELECT * FROM messages WHERE run_id = ? AND sequence = ?')
        .get(match[1], Number(match[2])) as MessageRow | undefined
      const stored =
        row &&
        (row.id.startsWith('omnios_result_')
          ? restoreConsoleJobResult(this.db, row)
          : restoreHubExecutionObservation(this.db, row))
      if (
        !row ||
        !stored ||
        stored.event !== observation.event ||
        stored.hubTaskId !== observation.hubTaskId ||
        stored.workerDispatchId !== observation.workerDispatchId
      ) {
        throw new Error('The committed execution observation does not match its journal cursor.')
      }
      if (
        !this.db.db
          .prepare('SELECT 1 FROM console_job_publications WHERE observation_id = ?')
          .get(row.id)
      ) {
        const binding = getConsoleJobBinding(this.db, row.run_id)
        const principal = this.db.getRun(row.run_id)?.console_job_principal
        if (!binding || !principal) {
          throw new Error('A console job publication requires its original person binding.')
        }
        if (
          stored.workerDispatchId &&
          JSON.stringify(getConsoleJobBindingForDispatch(this.db, stored.workerDispatchId)) !==
            JSON.stringify(binding)
        ) {
          throw new Error('A job observation requires the exact correlated Dispatch.')
        }
        if (this.sanitize(JSON.stringify(binding)) !== JSON.stringify(binding)) {
          throw new Error('The console job identity failed publication sanitization.')
        }
        const idempotencyKey = digest(JSON.stringify([binding, row.id]))
        const detail =
          stored.event === 'result' || stored.detail === undefined
            ? undefined
            : this.sanitize(stored.detail)
                .replace(/\b(?:run|task|ctx)_[A-Za-z0-9_-]+\b/g, '[local reference]')
                .slice(0, 1000)
        const payload: ConsoleJobPublicationPayload = {
          binding,
          journalCursor: `sha256:${digest(stored.journalCursor)}`,
          idempotencyKey,
          ...(stored.event === 'result'
            ? { result: stored.result }
            : { event: stored.event, ...(detail ? { detail } : {}) })
        }
        if (this.sanitize(JSON.stringify(payload)) !== JSON.stringify(payload)) {
          throw new Error('The committed job payload requires sanitization before publication.')
        }
        this.db.db
          .prepare(`INSERT INTO console_job_publications
          (observation_id, journal_sequence, idempotency_key, principal, payload)
          VALUES (?, ?, ?, ?, ?)`)
          .run(row.id, row.sequence, idempotencyKey, principal, JSON.stringify(payload))
      }
      this.db.db.exec('COMMIT')
    } catch (error) {
      this.db.db.exec('ROLLBACK')
      throw error
    }
  }

  recover(onFailure: () => void): void {
    let sequence = 0
    for (;;) {
      const rows = this.db.db
        .prepare(`SELECT m.* FROM messages m JOIN runs r ON r.id = m.run_id
        LEFT JOIN console_job_publications p ON p.observation_id = m.id
        WHERE r.console_job IS NOT NULL AND m.delivery_contract = 'audit_only'
          AND m.from_handle = 'runtime' AND (m.id LIKE 'omnios_observation_%' OR m.id LIKE 'omnios_result_%')
          AND p.observation_id IS NULL AND m.sequence > ? ORDER BY m.sequence LIMIT 100`)
        .all(sequence) as MessageRow[]
      for (const row of rows) {
        sequence = row.sequence
        try {
          const observation = row.id.startsWith('omnios_result_')
            ? restoreConsoleJobResult(this.db, row)
            : restoreHubExecutionObservation(this.db, row)
          if (observation) {
            this.capture(observation)
          } else {
            onFailure()
          }
        } catch {
          onFailure()
        }
      }
      if (rows.length < 100) {
        return
      }
    }
  }

  pending(afterSequence = 0): ConsoleJobPublicationRow[] {
    return this.db.db
      .prepare(`SELECT * FROM console_job_publications
      WHERE acknowledged_at IS NULL AND journal_sequence > ? ORDER BY journal_sequence LIMIT 100`)
      .all(afterSequence) as ConsoleJobPublicationRow[]
  }

  pendingCount(): number {
    return (
      this.db.db
        .prepare(`SELECT COUNT(*) AS count FROM console_job_publications
      WHERE acknowledged_at IS NULL`)
        .get() as { count: number }
    ).count
  }

  acknowledge(row: ConsoleJobPublicationRow, ack: ConsoleExecutionAck): boolean {
    const payload = JSON.parse(row.payload) as ConsoleJobPublicationPayload
    if (
      !ack ||
      ack.idempotencyKey !== row.idempotency_key ||
      ack.journalCursor !== payload.journalCursor ||
      typeof ack.eventId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(ack.eventId) ||
      this.sanitize(ack.eventId) !== ack.eventId
    ) {
      return false
    }
    this.db.db
      .prepare(`UPDATE console_job_publications
      SET acknowledged_at = COALESCE(acknowledged_at, datetime('now')), last_error = NULL
      WHERE observation_id = ? AND idempotency_key = ? AND payload = ?`)
      .run(row.observation_id, row.idempotency_key, row.payload)
    return true
  }

  fail(row: ConsoleJobPublicationRow, message: string, retryBlocked = false): void {
    const safeMessage = this.sanitize(message).slice(0, 1000)
    this.db.db
      .prepare(`UPDATE console_job_publications SET last_error = ?, retry_blocked = ?
      WHERE observation_id = ? AND acknowledged_at IS NULL`)
      .run(safeMessage, retryBlocked ? 1 : 0, row.observation_id)
  }
}
