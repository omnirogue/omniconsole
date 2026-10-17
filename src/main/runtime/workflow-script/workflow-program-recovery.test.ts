import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { reconcileWorkflowProgram } from './workflow-program-recovery'
import { runCouncilProgram, type CouncilProgramRevision } from './presets/council'
import { createWorkflowProgramContext, type WorkflowProgramCall } from './workflow-program-context'
import { workflowCallDigest } from './workflow-call-digest'
import type { WorkflowProgramSnapshot } from './workflow-execution-service'

const opened: OrchestrationDb[] = []
afterEach(() => opened.splice(0).forEach((db) => db.close()))

const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  task: { prompt: 'Question', evidence: 'Frozen evidence' },
  synthesizerId: 'claude',
  seats: [
    {
      id: 'claude',
      agent: 'claude',
      accountId: 'a',
      model: 'claude-model',
      effort: 'low',
      lineage: 'anthropic',
      policyRevision: 'test'
    },
    {
      id: 'codex',
      agent: 'codex',
      accountId: 'b',
      model: 'gpt-model',
      effort: 'low',
      lineage: 'openai',
      policyRevision: 'test'
    },
    {
      id: 'grok',
      agent: 'grok',
      accountId: 'c',
      model: 'grok-model',
      effort: null,
      lineage: 'xai',
      policyRevision: 'test'
    }
  ]
}
const answer = { markdown: 'Supported answer', sources: [], uncertainties: [] }

function fixture(frozen: WorkflowProgramSnapshot = { ...snapshot, councilProgramRevision: 4 }) {
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const executionId = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: frozen,
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 21
  })
  const reconcile = () =>
    reconcileWorkflowProgram({
      store,
      slots: new WorkflowScriptSlots(2),
      executionId,
      fence: 1,
      attestNativeResult: () => {}
    })
  const count = () =>
    (
      db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_attempts').get() as {
        count: number
      }
    ).count
  return { db, store, executionId, reconcile, count }
}

async function councilCalls(revision: CouncilProgramRevision = 4): Promise<WorkflowProgramCall[]> {
  const calls: WorkflowProgramCall[] = []
  const context = createWorkflowProgramContext({
    agent: async (call) => {
      calls.push(call)
      if (call.id.startsWith('peer/')) {
        const labels = ['Response A', 'Response B', 'Response C'].filter(
          (_, index) => snapshot.seats[index].id !== call.seatId
        )
        return {
          ranking: labels,
          assessments: labels.map((label) => ({
            label,
            strengths: 'Supported',
            weaknesses: 'Limited'
          }))
        }
      }
      return call.id.startsWith('answers/')
        ? answer
        : { markdown: 'Synthesis', sources: [], disagreements: [] }
    },
    guard: () => {},
    phase: () => {},
    log: () => {},
    isFatal: () => false
  })
  await runCouncilProgram(
    context,
    { panel: snapshot.seats, synthesizerId: snapshot.synthesizerId, revision },
    snapshot.task
  )
  return calls
}

function commit(f: ReturnType<typeof fixture>, call: WorkflowProgramCall, value: unknown) {
  const seat = snapshot.seats.find((entry) => entry.id === call.seatId)!
  const prepared = f.store.prepare({
    executionId: f.executionId,
    fence: 1,
    callId: call.id,
    inputDigest: workflowCallDigest(call, JSON.stringify(seat), seat.agent),
    reservation: 1,
    validate: () => {}
  })
  if (!('attemptId' in prepared)) {
    throw new Error('Expected attempt')
  }
  f.store.recordLaunch(prepared.attemptId, 1, prepared.attemptId)
  expect(
    f.store.accept(
      prepared.attemptId,
      1,
      value,
      {
        attemptId: prepared.attemptId,
        processReceiptRef: prepared.attemptId,
        liveness: 'exited'
      },
      () => {}
    )
  ).toBe(true)
}

describe('interrupted workflow program reconciliation', () => {
  it('reconciles an identifiable unversioned original Council without preparing work', async () => {
    const f = fixture({ ...snapshot, host: { startedAt: 1 } } as WorkflowProgramSnapshot)
    const calls = await councilCalls(1)
    commit(
      f,
      calls.find((call) => call.id === 'answers/claude')!,
      answer
    )
    f.store.requestControl(f.executionId, 1, 'pause')
    const before = f.count()
    expect(await f.reconcile()).toEqual({ state: 'paused' })
    expect(f.count()).toBe(before)
  })

  it('holds ambiguous unversioned partial Council evidence for manual recovery', async () => {
    const f = fixture({ ...snapshot, host: { startedAt: 1 } } as WorkflowProgramSnapshot)
    const calls = await councilCalls(3)
    commit(
      f,
      calls.find((call) => call.id === 'answers/claude')!,
      answer
    )
    f.store.requestControl(f.executionId, 1, 'pause')
    const before = f.count()
    expect(await f.reconcile()).toMatchObject({
      state: 'recovery_required',
      error: expect.stringContaining('ambiguous')
    })
    expect(f.count()).toBe(before)
  })

  it('reports a valid partial cache as paused without preparing missing calls', async () => {
    const f = fixture()
    const calls = await councilCalls()
    commit(
      f,
      calls.find((call) => call.id === 'answers/claude')!,
      answer
    )
    expect(f.store.requestControl(f.executionId, 1, 'pause')).toBe('paused')
    const before = f.count()
    expect(await f.reconcile()).toEqual({ state: 'paused' })
    expect(f.count()).toBe(before)
  })

  it('diagnoses an invalid frozen program instead of treating it as a clean pause', async () => {
    const f = fixture({ ...snapshot, version: 2 as 1 })
    f.store.requestControl(f.executionId, 1, 'pause')
    const outcome = await f.reconcile()
    expect(outcome.state).toBe('recovery_required')
    expect(outcome.error).toMatch(/Unsupported workflow program snapshot/)
    expect(f.count()).toBe(0)
  })

  it('diagnoses a schema-valid but semantically invalid cached peer ballot', async () => {
    const f = fixture()
    const calls = await councilCalls()
    for (const call of calls.filter((item) => item.id.startsWith('answers/'))) {
      commit(f, call, answer)
    }
    const peer = calls.find((call) => call.id === 'peer/claude')!
    commit(f, peer, {
      ranking: ['Response B', 'Response B'],
      assessments: [
        { label: 'Response B', strengths: 'S', weaknesses: 'W' },
        { label: 'Response C', strengths: 'S', weaknesses: 'W' }
      ]
    })
    f.store.requestControl(f.executionId, 1, 'pause')
    const before = f.count()
    const outcome = await f.reconcile()
    expect(outcome.state).toBe('recovery_required')
    expect(outcome.error).toMatch(/peer\/claude.*Peer ballot/)
    expect(f.count()).toBe(before)
  })

  it('diagnoses corrupted cached evidence and creates no attempt', async () => {
    const f = fixture()
    const calls = await councilCalls()
    commit(
      f,
      calls.find((call) => call.id === 'answers/claude')!,
      answer
    )
    f.store.requestControl(f.executionId, 1, 'pause')
    f.db.db
      .prepare("UPDATE local_workflow_calls SET result_json='{}' WHERE call_id='answers/claude'")
      .run()
    const before = f.count()
    const outcome = await f.reconcile()
    expect(outcome.state).toBe('recovery_required')
    expect(outcome.error).toMatch(/digest mismatch|recovery is blocked|incomplete or corrupt/i)
    expect(f.count()).toBe(before)
  })
})
