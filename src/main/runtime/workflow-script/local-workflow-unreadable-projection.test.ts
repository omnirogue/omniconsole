import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import { WorkflowCheckpointStore, workflowEvidenceDigest } from './workflow-checkpoint-store'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { projectLocalWorkflow } from './local-workflow-projection'

vi.mock('./workflow-process-receipt', () => ({ readWorkflowProcessReceipt: vi.fn() }))
vi.mock('./workflow-launch-receipt', () => ({ readWorkflowLaunchedAt: vi.fn() }))
// The Council package owns its run view; these tests cover only what a run it cannot read shows.
vi.mock('./local-workflow-council-projection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  councilStageDefinitions: () => [],
  projectCouncilRun: () => undefined,
  councilResultMarkdown: () => undefined
}))

const databases: OrchestrationDb[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  vi.clearAllMocks()
})

const snapshot: LocalWorkflowHostSnapshot = {
  version: 1,
  councilProgramRevision: 6,
  access: 'workspace-read',
  task: { prompt: 'Which cache should we use?', evidence: '' },
  seats: (
    [
      ['seat-1', 'claude', 'claude-opus-5', 'anthropic'],
      ['seat-2', 'codex', 'gpt-5.6-sol', 'openai'],
      ['seat-3', 'gemini', 'gemini-3.8-flash', 'google']
    ] as const
  ).map(([id, agent, model, lineage]) => ({
    id,
    agent,
    model,
    lineage,
    accountId: 'account',
    effort: null,
    policyRevision: 'test'
  })),
  synthesizerId: 'seat-1',
  council: { memberIds: ['seat-1', 'seat-2', 'seat-3'] },
  discover: createLocalWorkflowDraft('council').discover,
  host: {
    workspaceId: 'workspace',
    conversationId: 'conversation',
    requestDigest: 'digest',
    startedAt: 1_000,
    concurrency: 2,
    sources: [],
    coverage: []
  }
}

/** A Council run with one answered call, in `state`. */
function fixture(state: string) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const id = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot,
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 21
  })
  const json = JSON.stringify({ markdown: 'Use an LRU cache.' })
  db.db
    .prepare(
      'INSERT INTO local_workflow_calls (execution_id, call_id, input_digest, result_json, result_digest) VALUES (?, ?, ?, ?, ?)'
    )
    .run(id, 'answer/seat-1', 'input', json, workflowEvidenceDigest(json))
  const sql = (statement: string) => db.db.prepare(statement).run(id)
  sql(`UPDATE local_workflow_executions SET state='${state}' WHERE id=?`)
  const project = (input: Partial<Parameters<typeof projectLocalWorkflow>[0]> = {}) =>
    projectLocalWorkflow({ db: db.db, store, executionId: id, active: false, ...input })
  return { store, id, sql, project }
}

describe('a run whose records this build cannot project', () => {
  it('keeps a live run live, with its Stop, and says it is damaged once it settles', () => {
    // Why: a live run is still running whatever its records say; it must never read as stopped
    // with no Stop, and a digest that no longer matches is damage, not an earlier version.
    const f = fixture('running')
    f.sql("UPDATE local_workflow_calls SET result_digest='x' WHERE execution_id=?")
    const live = f.project({ active: true })
    expect(live).toMatchObject({
      state: 'running',
      actions: ['stop'],
      prompt: 'Which cache should we use?',
      error: 'Workflow result integrity failure: answer/seat-1'
    })
    expect(live.unreadable).toBeUndefined()
    expect(f.project({ active: false })).toMatchObject({
      state: 'cancelled',
      actions: [],
      prompt: 'Which cache should we use?',
      startedAt: 1_000,
      unreadable: 'damaged'
    })
  })

  it('reads a result the program no longer accepts as the work of an earlier version', () => {
    // Replay quarantined a result whose digest still matches: this build's validator rejects it.
    const f = fixture('recovery_failed')
    f.sql('UPDATE local_workflow_calls SET quarantined=1 WHERE execution_id=?')
    expect(f.project()).toMatchObject({
      state: 'cancelled',
      prompt: 'Which cache should we use?',
      unreadable: 'earlier-version',
      error: 'Workflow recovery is blocked'
    })
  })
})

describe('an interrupted run after a restart', () => {
  /** The store's own words when this build's program asks a recorded call differently. */
  function identityChanged(f: ReturnType<typeof fixture>): string {
    try {
      f.store.prepare({
        executionId: f.id,
        fence: 1,
        callId: 'answer/seat-1',
        inputDigest: 'changed',
        reservation: 0,
        validate: () => {}
      })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error('A changed call identity was accepted')
  }

  it('reads as recorded by an earlier version when its program no longer replays it', () => {
    // Why: reconciling such a run returns recovery_required and leaves it paused, so it read as
    // "Needs you" with no action after every restart, though resuming fails the same way.
    const f = fixture('running')
    const error = `answer/seat-1: ${identityChanged(f)}`
    f.sql("UPDATE local_workflow_executions SET state='paused' WHERE id=?")
    expect(f.project({ outcome: { state: 'recovery_required', error } })).toMatchObject({
      state: 'cancelled',
      actions: [],
      calls: [],
      prompt: 'Which cache should we use?',
      unreadable: 'earlier-version',
      error
    })
  })

  it('keeps any other blocked recovery as it is, with its calls', () => {
    const f = fixture('paused')
    const view = f.project({
      outcome: { state: 'recovery_required', error: 'Unresolved workflow attempts remain' }
    })
    expect(view).toMatchObject({
      state: 'recovery_required',
      prompt: 'Which cache should we use?',
      error: 'Unresolved workflow attempts remain'
    })
    expect(view.unreadable).toBeUndefined()
    expect(view.calls.map((call) => call.id)).toEqual(['answer/seat-1'])
  })
})
