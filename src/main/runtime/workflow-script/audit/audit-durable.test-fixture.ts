import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../../orchestration/db'
import { WorkflowCheckpointStore } from '../workflow-checkpoint-store'
import { WorkflowScriptSlots } from '../workflow-script-slots'
import { createDurableWorkflowAgent } from '../workflow-durable-call'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import { auditFixtureSnapshot } from '../../../../../config/scripts/workflows/probe-audit-pipeline'
import { auditFixtureResponse } from '../../../../../config/scripts/workflows/fixtures/audit-pipeline-fixture'
import { auditCallLimit, readAuditSources } from './audit-snapshot'
import { verifyAuditEvidence } from './audit-evidence'
import { observeAuditJudgements } from './audit-judgements'
import type { AuditProgramPorts } from './audit-program'
import type { AuditProgramRevision } from './audit-program-revision'

export function auditDurableFixture(
  change: (call: WorkflowProgramCall, value: unknown) => unknown = (_call, value) => value,
  revision: AuditProgramRevision = 1
) {
  const directory = mkdtempSync(join(tmpdir(), 'audit-durable-'))
  const snapshot = auditFixtureSnapshot(directory)
  const audit = snapshot.audit!
  audit.version = revision
  const db = new OrchestrationDb(':memory:')
  const store = new WorkflowCheckpointStore(db.db)
  const executionId = store.create({
    conversationId: 'audit-test',
    requestId: 'first',
    snapshot,
    preset: 'discover',
    fence: 1,
    attemptLimit: 3,
    callLimit: auditCallLimit(audit),
    budgetLimit: 200
  })
  const calls: { id: string; ordinal: number; problems: string | null }[] = []
  const controller = new AbortController()
  let seatIdentity = 'claude:fixture-model:high:fixture-account:policy-v1'
  const agent = createDurableWorkflowAgent({
    store,
    executionId,
    fence: 1,
    slots: new WorkflowScriptSlots(3),
    signal: controller.signal,
    reservation: 1,
    seatFingerprint: () => seatIdentity,
    route: () => 'claude',
    closeAdmission: (error) => controller.abort(error),
    launch: async (input) => {
      calls.push({ id: input.call.id, ordinal: input.ordinal, problems: input.problems })
      input.recordLaunch(input.attemptId)
      const value = change(input.call, auditFixtureResponse(input.call))
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
            modelUsage: { 'fixture-claude': {} },
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
  })
  const context = createWorkflowProgramContext({
    agent,
    phase: () => {},
    log: () => {},
    guard: () => {},
    isFatal: () => false
  })
  const ports: AuditProgramPorts = {
    checkEvidence: async (citations) => {
      const sources = readAuditSources(audit.sourceFile, audit.format)
      const check = await verifyAuditEvidence(
        citations,
        audit.corpus.sources,
        async (id) => sources.find((source) => source.id === id) ?? null
      )
      return { check, excerpts: [] }
    },
    observeJudgements: (request) => observeAuditJudgements(request, { record: () => {} })
  }
  return {
    snapshot,
    audit,
    db,
    store,
    calls,
    context,
    ports,
    changeSeatIdentity: () => {
      seatIdentity = 'claude:fixture-model:low:other-account:policy-v1'
    },
    close: () => {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
