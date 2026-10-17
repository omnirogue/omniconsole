import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleExecutionObservation } from '../../../shared/console-workflow-types'
import { registerConsoleJobPublication } from '../../backoffice/console-job-publication-registration'
import { OrcaRuntimeService } from '../omni-runtime'
import { admitOrchestrationRun } from './run-admission'
import { consoleJobActivationReceipt } from './console-job-activation-receipt'
import { getConsoleJobBinding } from './console-job-binding'
import {
  consoleJobClaimFixture,
  consoleJobDigestFixture,
  consoleJobFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from './console-job-test-fixture'
import { OrchestrationDb } from './db/orchestration-db'

describe('committed runtime observations route exclusively by job binding', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let registration: ReturnType<typeof registerConsoleJobPublication> | undefined
  const legacy = vi.fn(async () => ({ ok: true as const, noteId: 'note_legacy' }))
  const publish = vi.fn(async (input: ConsoleExecutionObservation) => ({
    ok: true as const,
    data: {
      eventId: 'event_journal',
      journalCursor: input.journalCursor,
      idempotencyKey: input.idempotencyKey
    }
  }))
  beforeEach(() => {
    legacy.mockClear()
    publish.mockClear()
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    runtime.setOrchestrationObservationReporter(legacy)
  })
  afterEach(async () => {
    await registration?.dispose()
    registration = undefined
    db.close()
    vi.restoreAllMocks()
  })

  function register() {
    registration = registerConsoleJobPublication(runtime, {
      publish,
      getPrincipal: async () => consoleJobPrincipalFixture,
      sanitize: (value) => value
    })
    return registration
  }

  it.each([consoleJobFixture, consoleJobClaimFixture])(
    'commits job correlation before run_started, including claim-only activation: %j',
    async (binding) => {
      const first = register()
      expect(register()).toBe(first)
      runtime.setOrchestrationObservationReporter(legacy)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(
        'tab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      )
      // Why: `orchestration.runCreate` refuses console job parameters outright,
      // so a binding is only ever installed through this main-only admission.
      const result = admitOrchestrationRun({
        runtime,
        objective: 'Execute admitted content work',
        callerTerminalHandle: 'term_coord',
        hubTaskId: binding.taskId,
        consoleJob: {
          binding,
          principal: consoleJobPrincipalFixture,
          activation: consoleJobActivationReceipt(binding, consoleJobDigestFixture)
        }
      }) as { run: { id: string }; projectionTaskId: string }
      expect(getConsoleJobBinding(db, result.run.id)).toEqual(binding)
      expect(db.getTask(result.projectionTaskId)?.run_id).toBe(result.run.id)
      await first.publication.flush()
      expect(publish).toHaveBeenCalledTimes(1)
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ binding, event: 'run_started' }),
        consoleJobPrincipalFixture
      )
      expect(legacy).not.toHaveBeenCalled()
      runtime.recordOrchestrationExecutionObservation({
        runId: result.run.id,
        event: 'run_started'
      })
      await first.publication.flush()
      expect(publish).toHaveBeenCalledTimes(1)
    }
  )

  it('retains job observations when the adapter is absent and recovers them on registration without a legacy comment', async () => {
    const run = createConsoleJobRun(db)
    runtime.recordOrchestrationExecutionObservation({ runId: run.id, event: 'run_started' })
    expect(legacy).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    await register().publication.flush()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('keeps no-job hub compatibility on its one-shot reporter and ad hoc work local', async () => {
    register()
    const compatible = db.createRun({
      objective: 'Content',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: 'tab:old',
      hubTaskId: 'btk_legacy'
    })
    const local = db.createRun({
      objective: 'Ad hoc',
      coordinatorHandle: 'term_local',
      coordinatorPaneKey: 'tab:local'
    })
    for (const run of [compatible, local]) {
      runtime.recordOrchestrationExecutionObservation({ runId: run.id, event: 'run_started' })
      runtime.recordOrchestrationExecutionObservation({ runId: run.id, event: 'run_started' })
    }
    await registration!.publication.flush()
    expect(legacy).toHaveBeenCalledTimes(1)
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ hubTaskId: 'btk_legacy' }))
    expect(publish).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
  })

  it('does not log raw input or thrown transport errors when journal capture fails', () => {
    const run = createConsoleJobRun(db)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const token = 'opaque-caught-error-sentinel'
    vi.spyOn(db, 'getRun').mockImplementation(() => {
      throw new Error(token)
    })
    runtime.recordOrchestrationExecutionObservation({
      runId: run.id,
      event: 'run_started',
      detail: token
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token)
    expect(legacy).not.toHaveBeenCalled()
  })
})
