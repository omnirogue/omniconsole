import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { createRootDispatch } from '../runtime/orchestration/db/root-dispatch-test-fixture'
import { createHubTaskProjection } from '../runtime/orchestration/db/tasks/task-store'
import {
  consoleJobFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from '../runtime/orchestration/console-job-test-fixture'
import {
  readConsoleJobResult,
  recordConsoleJobResult,
  type ConsoleJobResultPublication
} from '../runtime/orchestration/console-job-result'
import { ConsoleJobPublication, type ConsoleJobPublicationOptions } from './console-job-publication'
import { redactConsoleWorkflowValue } from './console-workflow-redaction'

const TOKEN = 'opaque-result-journal-sentinel'
const sanitize = (text: string) => String(redactConsoleWorkflowValue(text, TOKEN))

describe('frozen accepted results in the existing journal and publication cache', () => {
  let directory: string
  let path: string
  let db: OrchestrationDb
  const publications: ConsoleJobPublication[] = []
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omni-result-publication-'))
    path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
  })
  afterEach(async () => {
    await Promise.all(publications.splice(0).map((publication) => publication.dispose()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  function dispatch() {
    const run = createConsoleJobRun(db)
    const task = createHubTaskProjection(db, { runId: run.id, hubTaskId: consoleJobFixture.taskId })
    const worker = createRootDispatch(db, task.id, 'term_worker')
    return { runId: run.id, workerDispatchId: worker.id }
  }

  function publication(options: Partial<ConsoleJobPublicationOptions> = {}) {
    const publisher = new ConsoleJobPublication({
      db,
      sanitize,
      getPrincipal: async () => consoleJobPrincipalFixture,
      publish: async () => {
        throw new Error('Results cannot use the observation transport')
      },
      ...options
    })
    publications.push(publisher)
    return publisher
  }

  it('sanitizes before journal commit, reopens the accepted result, and refuses changed acceptance', () => {
    const identity = dispatch()
    const result = {
      status: 'pr_open',
      output_digest: 'd'.repeat(64),
      output_tail: `${TOKEN} ${identity.runId}`,
      terminal_proof: { kind: 'exited', exit_code: 0 }
    }
    const recorded = recordConsoleJobResult(db, { ...identity, result }, sanitize)
    expect(recorded.fresh).toBe(true)
    expect(recorded.observation.result.output_tail).toBe('[redacted] [local reference]')
    expect(JSON.stringify(db.db.prepare('SELECT * FROM messages').all())).not.toContain(TOKEN)
    expect(db.getUnreadMessages(`run:${identity.runId}`, ['status'])).toEqual([])
    db.close()
    db = new OrchestrationDb(path)
    expect(readConsoleJobResult(db, identity.runId, identity.workerDispatchId)).toEqual(
      recorded.observation
    )
    expect(
      recordConsoleJobResult(
        db,
        {
          ...identity,
          result: {
            terminal_proof: { exit_code: 0, kind: 'exited' },
            output_tail: result.output_tail,
            output_digest: result.output_digest,
            status: 'pr_open'
          }
        },
        sanitize
      ).fresh
    ).toBe(false)
    expect(() =>
      recordConsoleJobResult(db, { ...identity, result: { ...result, status: 'failed' } }, sanitize)
    ).toThrow('already frozen')
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
  })

  it('recovers a result commit gap and replays one exact result receipt after the response is lost', async () => {
    const identity = dispatch()
    const accepted = {
      status: 'pr_open',
      output_digest: 'd'.repeat(64),
      candidate_sha: 'c'.repeat(40)
    }
    recordConsoleJobResult(db, { ...identity, result: accepted }, sanitize)
    db.close()
    db = new OrchestrationDb(path)
    const server = new Set<string>()
    const payloads: string[] = []
    const publishResult = vi.fn(async (input: ConsoleJobResultPublication, principal: string) => {
      expect(principal).toBe(consoleJobPrincipalFixture)
      expect(input.result).toEqual(accepted)
      expect(JSON.stringify(input)).not.toContain(identity.runId)
      expect(JSON.stringify(input)).not.toContain(identity.workerDispatchId)
      payloads.push(JSON.stringify(input))
      if (!server.has(input.idempotencyKey)) {
        server.add(input.idempotencyKey)
        throw new Error('response lost')
      }
      return {
        ok: true as const,
        data: {
          eventId: 'event_result',
          journalCursor: input.journalCursor,
          idempotencyKey: input.idempotencyKey
        }
      }
    })
    const first = publication({ publishResult })
    await first.flush()
    expect(first.journal.pendingCount()).toBe(1)
    await first.dispose()
    db.close()
    db = new OrchestrationDb(path)
    const second = publication({ publishResult })
    await second.flush()
    expect(second.journal.pendingCount()).toBe(0)
    expect(payloads[1]).toBe(payloads[0])
    expect(server.size).toBe(1)
    await second.flush()
    expect(publishResult).toHaveBeenCalledTimes(2)
  })

  it('hands only an acknowledged result to auto-advance, and a throwing hook cannot fail it', async () => {
    const identity = dispatch()
    const recorded = recordConsoleJobResult(
      db,
      { ...identity, result: { status: 'pr_open', output_digest: 'd'.repeat(64) } },
      sanitize
    )
    const onResultPublished = vi.fn((_published: ConsoleJobResultPublication) => {
      throw new Error('auto-advance is unavailable')
    })
    let acknowledge = false
    const publisher = publication({
      onResultPublished,
      publishResult: async (input) => {
        if (!acknowledge) {
          return { ok: false as const, error: { code: 'offline', message: 'no contact' } }
        }
        return {
          ok: true as const,
          data: {
            eventId: 'event_result',
            journalCursor: input.journalCursor,
            idempotencyKey: input.idempotencyKey
          }
        }
      }
    })
    publisher.onCommittedResult(recorded.observation)
    await publisher.flush()
    expect(onResultPublished).not.toHaveBeenCalled()
    acknowledge = true
    await publisher.flush()
    expect(publisher.journal.pendingCount()).toBe(0)
    expect(onResultPublished).toHaveBeenCalledTimes(1)
    expect(onResultPublished.mock.calls[0]![0]).toMatchObject({
      binding: { jobId: consoleJobFixture.jobId, workflowId: consoleJobFixture.workflowId }
    })
  })

  it('retains the frozen result without a result publisher and refuses foreign dispatch correlation', async () => {
    const identity = dispatch()
    const result = { status: 'failed', output_digest: 'd'.repeat(64) }
    const recorded = recordConsoleJobResult(db, { ...identity, result }, sanitize)
    const publisher = publication()
    publisher.onCommittedResult(recorded.observation)
    await publisher.flush()
    expect(publisher.journal.pendingCount()).toBe(1)
    expect(publisher.journal.pending()[0].last_error).toContain('does not yet provide')
    expect(() =>
      recordConsoleJobResult(db, { ...identity, runId: 'run_foreign', result }, sanitize)
    ).toThrow('exact console job')
  })
})
