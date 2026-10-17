import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { readLocalWorkflowCallLog } from './local-workflow-call-log'
import { readWorkflowProcessReceipt } from './workflow-process-receipt'
import type { WorkflowProcessReceiptIdentity } from './workflow-process-receipt-identity'

vi.mock('./workflow-process-receipt', () => ({ readWorkflowProcessReceipt: vi.fn() }))

const databases: OrchestrationDb[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  vi.clearAllMocks()
})

function fixture() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const draft = createLocalWorkflowDraft('council', 'Which cache should we use?')
  const id = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: { version: 1, task: { prompt: draft.prompt, evidence: '' }, seats: [] },
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 21
  })
  const attempt = (attemptId: string, ordinal: number, state: string, receipt: unknown) =>
    db.db
      .prepare(
        'INSERT INTO local_workflow_attempts (id,execution_id,call_id,ordinal,fence,state,reservation,receipt_json) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(attemptId, id, 'chair/final', ordinal, 1, state, 1, JSON.stringify(receipt))
  db.db
    .prepare(
      'INSERT INTO local_workflow_calls (execution_id, call_id, input_digest) VALUES (?, ?, ?)'
    )
    .run(id, 'chair/final', 'input')
  vi.spyOn(store, 'readProcessIdentity').mockImplementation(
    (attemptId) => ({ attemptId }) as unknown as WorkflowProcessReceiptIdentity
  )
  vi.mocked(readWorkflowProcessReceipt).mockImplementation((identity) => ({
    result: {
      code: 1,
      signal: null,
      timedOut: false,
      stdout: `stdout of ${identity.attemptId}`,
      stderr: 'schema mismatch',
      stdoutTruncated: true
    },
    receipt: { attemptId: identity.attemptId, processReceiptRef: 'x', liveness: 'exited' },
    launchedAt: 1,
    exitedAt: 2
  }))
  return { db, store, id, attempt }
}

describe('reading one call log', () => {
  it('reads the last launched attempt while a retry is still running', () => {
    const f = fixture()
    f.attempt('attempt-1', 1, 'failed', { attemptId: 'attempt-1', processReceiptRef: 'x' })
    f.attempt('attempt-2', 2, 'failed', { attemptId: 'attempt-2', noLaunch: true, reason: 'Busy' })
    f.attempt('attempt-3', 3, 'running', { processReceiptRef: 'y' })
    expect(readLocalWorkflowCallLog(f.db.db, f.store, f.id, 'chair/final')).toEqual({
      stdout: 'stdout of attempt-1',
      stderr: 'schema mismatch',
      outputTruncated: true,
      attempt: 1
    })
    expect(readWorkflowProcessReceipt).toHaveBeenCalledTimes(1)
  })

  it('has no logs, and no attempt, before any attempt has launched and exited', () => {
    const f = fixture()
    expect(readLocalWorkflowCallLog(f.db.db, f.store, f.id, 'chair/final')).toEqual({
      stdout: '',
      stderr: '',
      outputTruncated: false
    })
    f.attempt('attempt-1', 1, 'running', { processReceiptRef: 'y' })
    expect(readLocalWorkflowCallLog(f.db.db, f.store, f.id, 'chair/final')).toEqual({
      stdout: '',
      stderr: '',
      outputTruncated: false
    })
    expect(readWorkflowProcessReceipt).not.toHaveBeenCalled()
  })
})
