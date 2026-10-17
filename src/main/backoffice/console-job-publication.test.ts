import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleExecutionObservation } from '../../shared/console-workflow-types'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { recordHubExecutionObservation } from '../runtime/orchestration/hub-execution-observation'
import {
  consoleJobFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from '../runtime/orchestration/console-job-test-fixture'
import { ConsoleJobPublication, type ConsoleJobPublicationOptions } from './console-job-publication'
import { redactConsoleWorkflowValue } from './console-workflow-redaction'

const TOKEN = 'opaque-journal-secret-sentinel'
const sanitize = (text: string) => String(redactConsoleWorkflowValue(text, TOKEN))
const ack = (input: ConsoleExecutionObservation) => ({
  ok: true as const,
  data: {
    eventId: 'event_committed',
    journalCursor: input.journalCursor,
    idempotencyKey: input.idempotencyKey
  }
})

describe('durable person-scoped console journal publication', () => {
  let directory: string
  let path: string
  let db: OrchestrationDb
  const publications: ConsoleJobPublication[] = []
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omni-job-publication-'))
    path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
  })
  afterEach(async () => {
    await Promise.all(publications.splice(0).map((publication) => publication.dispose()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function publication(options: Partial<ConsoleJobPublicationOptions> = {}) {
    const publisher = new ConsoleJobPublication({
      db,
      sanitize,
      getPrincipal: async () => consoleJobPrincipalFixture,
      publish: async (input) => ack(input),
      ...options
    })
    publications.push(publisher)
    return publisher
  }

  function record(runId: string, checkpointCursor = 'provider:epoch:8', detail?: string) {
    return recordHubExecutionObservation(db, {
      runId,
      event: 'checkpoint_written',
      checkpointCursor,
      detail
    })!.observation
  }

  it('reopens a crash between journal commit and outbox capture, with cursor and payload committed before publish', async () => {
    const run = createConsoleJobRun(db)
    const observation = record(run.id)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM console_job_publications').get()).toEqual({
      count: 0
    })
    db.close()
    db = new OrchestrationDb(path)
    const publish = vi.fn(async (input: ConsoleExecutionObservation) => {
      const observer = new OrchestrationDb(path)
      try {
        expect(observer.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
          count: 1
        })
        expect(
          observer.db
            .prepare('SELECT payload FROM console_job_publications WHERE idempotency_key = ?')
            .get(input.idempotencyKey)
        ).toEqual({ payload: JSON.stringify(input) })
      } finally {
        observer.close()
      }
      expect(input.journalCursor).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(JSON.stringify(input)).not.toContain(run.id)
      expect(JSON.stringify(input)).not.toContain(observation.journalCursor)
      expect(input.binding).toEqual(consoleJobFixture)
      return ack(input)
    })
    const publisher = publication({ publish })
    await publisher.flush()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publisher.journal.pendingCount()).toBe(0)
  })

  it('replays the identical receipt after a lost response and retains the acknowledgement across another reopen', async () => {
    const run = createConsoleJobRun(db)
    record(run.id)
    const serverReceipts = new Map<string, string>()
    const payloads: string[] = []
    const publish = vi.fn(async (input: ConsoleExecutionObservation) => {
      payloads.push(JSON.stringify(input))
      if (!serverReceipts.has(input.idempotencyKey)) {
        serverReceipts.set(input.idempotencyKey, 'event_committed')
        throw new Error(`response lost ${TOKEN}`)
      }
      return ack(input)
    })
    const first = publication({ publish })
    await first.flush()
    expect(first.journal.pendingCount()).toBe(1)
    await first.dispose()
    db.close()
    db = new OrchestrationDb(path)
    const second = publication({ publish })
    await second.flush()
    expect(payloads[1]).toBe(payloads[0])
    expect(serverReceipts.size).toBe(1)
    expect(second.journal.pendingCount()).toBe(0)
    await second.dispose()
    db.close()
    db = new OrchestrationDb(path)
    await publication({ publish }).flush()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('coalesces duplicate capture/flush and accepts duplicate exact acknowledgements', async () => {
    const run = createConsoleJobRun(db)
    const observation = record(run.id)
    const publish = vi.fn(async (input: ConsoleExecutionObservation) => ack(input))
    const publisher = publication({ publish })
    publisher.journal.capture(observation)
    publisher.journal.capture(observation)
    const row = publisher.journal.pending()[0]
    await Promise.all([publisher.flush(), publisher.flush(), publisher.flush()])
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publisher.journal.acknowledge(row, ack(JSON.parse(row.payload)).data)).toBe(true)
    expect(publisher.journal.pendingCount()).toBe(0)
    await publisher.flush()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('keeps entries until an exact ack and preserves ordering for a blocked job without blocking other jobs', async () => {
    const firstRun = createConsoleJobRun(db)
    const secondRun = createConsoleJobRun(db, { ...consoleJobFixture, jobId: 'job_second' })
    record(firstRun.id, 'provider:epoch:8')
    record(firstRun.id, 'provider:epoch:9')
    record(secondRun.id)
    const publish = vi.fn(async (input: ConsoleExecutionObservation) =>
      input.binding.jobId === 'job_second'
        ? ack(input)
        : { ok: true as const, data: { ...ack(input).data, idempotencyKey: 'wrong-receipt' } }
    )
    const publisher = publication({ publish })
    await publisher.flush()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publisher.journal.pendingCount()).toBe(2)
    publish.mockImplementation(async (input) => ack(input))
    await publisher.flush()
    expect(publish).toHaveBeenCalledTimes(4)
    expect(publisher.journal.pendingCount()).toBe(0)
  })

  it('retains an unavailable transport and sanitizes the outbox, warnings and boundary detail', async () => {
    const run = createConsoleJobRun(db)
    record(
      run.id,
      `provider:${TOKEN}:epoch:8`,
      `Evidence ${TOKEN}; ${run.id}; ctx_local task_local`
    )
    const warn = vi.fn()
    const publish = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'capability_unavailable', message: `Unavailable ${TOKEN}` }
    }))
    const publisher = publication({ publish, warn })
    await publisher.flush()
    const stored = JSON.stringify(db.db.prepare('SELECT * FROM console_job_publications').all())
    expect(stored).not.toContain(TOKEN)
    expect(stored).not.toContain(run.id)
    expect(stored).not.toContain('ctx_local')
    expect(stored).not.toContain('task_local')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
    expect(stored).toContain('[redacted]')
    expect(publisher.journal.pendingCount()).toBe(1)
  })

  it('never replays under a changed or absent person and passes the original principal to the transport', async () => {
    const run = createConsoleJobRun(db)
    record(run.id)
    const getPrincipal = vi.fn<() => Promise<string | null>>().mockResolvedValue('b'.repeat(64))
    const publish = vi.fn(async (input: ConsoleExecutionObservation) => ack(input))
    const publisher = publication({ getPrincipal, publish })
    await publisher.flush()
    getPrincipal.mockResolvedValue(null)
    await publisher.flush()
    expect(publish).not.toHaveBeenCalled()
    expect(publisher.journal.pendingCount()).toBe(1)
    getPrincipal.mockResolvedValue(consoleJobPrincipalFixture)
    await publisher.flush()
    expect(publish).toHaveBeenCalledWith(expect.any(Object), consoleJobPrincipalFixture)
  })

  it('does not publish a rolled-back observation or a fabricated cursor', async () => {
    const run = createConsoleJobRun(db)
    const publish = vi.fn(async (input: ConsoleExecutionObservation) => ack(input))
    const publisher = publication({ publish })
    db.db.exec('BEGIN IMMEDIATE')
    const observation = record(run.id)
    expect(() => publisher.journal.capture(observation)).toThrow()
    db.db.exec('ROLLBACK')
    await publisher.flush()
    expect(publish).not.toHaveBeenCalled()
    expect(() => publisher.journal.capture(observation)).toThrow('does not match')
    expect(() => publisher.journal.capture({ ...observation, journalCursor: 'fake' })).toThrow(
      'committed'
    )
    record(run.id)
    await publisher.flush()
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('keeps pending transport receipts across runtime inbox reset', async () => {
    const run = createConsoleJobRun(db)
    const observation = record(run.id)
    const publisher = publication()
    publisher.journal.capture(observation)
    db.resetMessages()
    await publisher.flush()
    expect(publisher.journal.pendingCount()).toBe(0)
  })

  it('retains an explicit generation refusal across restart without retrying unchanged input', async () => {
    const run = createConsoleJobRun(db)
    record(run.id)
    const publish = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'stale_claim', status: 409, message: 'Generation replaced' }
    }))
    const first = publication({ publish })
    await first.flush()
    await first.dispose()
    db.close()
    db = new OrchestrationDb(path)
    const restored = publication({ publish })
    await restored.flush()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(restored.journal.pendingCount()).toBe(1)
    expect(restored.journal.pending()[0].retry_blocked).toBe(1)
  })
})
