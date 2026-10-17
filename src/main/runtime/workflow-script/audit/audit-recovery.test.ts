import { renameSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowExecutionService } from '../workflow-execution-service'
import { WorkflowScriptSlots } from '../workflow-script-slots'
import { reconcileWorkflowProgram } from '../workflow-program-recovery'
import type { WorkflowAttemptLaunch } from '../workflow-durable-call'
import { auditDurableFixture } from './audit-durable.test-fixture'
import { auditCallLimit } from './audit-snapshot'
import * as corpusSource from './audit-snapshot'
import * as judgements from './audit-judgements'
import { auditFixtureResponse } from '../../../../../config/scripts/workflows/fixtures/audit-pipeline-fixture'

const fixtures: ReturnType<typeof auditDurableFixture>[] = []
afterEach(() => {
  vi.restoreAllMocks()
  fixtures.splice(0).forEach((fixture) => fixture.close())
})

describe('interrupted audit reconciliation', () => {
  it.each([
    { phase: 'Verify evidence, impact and status', accepted: 9, revision: 1 as const },
    { phase: 'Plan and judge', accepted: 15, revision: 1 as const },
    { phase: 'Plan and judge', accepted: 15, revision: 2 as const },
    { phase: 'Plan and judge', accepted: 15, revision: 3 as const },
    { phase: 'Plan and judge', accepted: 15, revision: 4 as const },
    { phase: 'Plan and judge', accepted: 15, revision: 5 as const }
  ])(
    'holds a revision $revision pause at $phase without evaluating missing host facts',
    async ({ phase, accepted, revision }) => {
      const f = auditDurableFixture(undefined, revision)
      fixtures.push(f)
      const sourceReads = vi.spyOn(corpusSource, 'readAuditSources')
      const observations = vi.spyOn(judgements, 'observeAuditJudgements')
      const snapshot = structuredClone(f.snapshot)
      snapshot.seats = snapshot.seats.map((seat) => ({ ...seat, agent: 'claude' }))
      const calls: string[] = []
      const launch: WorkflowAttemptLaunch = async (input) => {
        calls.push(input.call.id)
        input.recordLaunch(input.attemptId)
        const value = auditFixtureResponse(input.call)
        const model = snapshot.seats.find((seat) => seat.id === input.call.seatId)!.model!
        return {
          result: {
            code: 0,
            signal: null,
            timedOut: false,
            stderr: '',
            stdout: JSON.stringify({
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: input.attemptId,
              structured_output: value,
              modelUsage: { [model]: {} },
              usage: {}
            })
          },
          receipt: {
            attemptId: input.attemptId,
            processReceiptRef: input.attemptId,
            liveness: 'exited'
          }
        }
      }
      let paused = false
      const service = new WorkflowExecutionService({
        store: f.store,
        slots: new WorkflowScriptSlots(3),
        reservation: 1,
        launch: () => launch,
        progress: (id, event) => {
          if (!paused && event.phase === phase) {
            paused = true
            service.control(id, 1, 'pause')
          }
        }
      })
      const executionId = service.start({
        conversationId: 'audit-recovery',
        requestId: 'pause',
        snapshot,
        preset: 'discover',
        fence: 1,
        attemptLimit: 3,
        callLimit: auditCallLimit(f.audit),
        budgetLimit: 200
      })
      expect((await service.wait(executionId)).state).toBe('paused')
      expect(calls).toHaveLength(accepted)
      const readsBefore = sourceReads.mock.calls.length
      const observationsBefore = observations.mock.calls.length
      const sourceFile = snapshot.audit!.sourceFile
      renameSync(sourceFile, `${sourceFile}.away`)
      expect(
        await reconcileWorkflowProgram({
          store: f.store,
          slots: new WorkflowScriptSlots(3),
          executionId,
          fence: 1,
          attestNativeResult: () => {}
        })
      ).toEqual({ state: 'paused' })
      expect(calls).toHaveLength(accepted)
      expect(sourceReads).toHaveBeenCalledTimes(readsBefore)
      expect(observations).toHaveBeenCalledTimes(observationsBefore)
      renameSync(`${sourceFile}.away`, sourceFile)
      const resumed = new WorkflowExecutionService({
        store: f.store,
        slots: new WorkflowScriptSlots(3),
        reservation: 1,
        launch: () => launch,
        progress: () => {}
      })
      resumed.resume(executionId, 1)
      expect((await resumed.wait(executionId)).state).toBe('completed')
      expect(calls).toHaveLength(23)
      expect(new Set(calls).size).toBe(23)
      expect(f.store.pendingAttempts(executionId, 1)).toEqual([])
    }
  )
})
