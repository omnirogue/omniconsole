import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import { WorkflowCheckpointStore } from '../workflow-checkpoint-store'
import { WorkflowScriptSlots } from '../workflow-script-slots'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from '../workflow-execution-service'
import type { WorkflowAttemptLaunch } from '../workflow-durable-call'
import type { WorkflowProgramCall } from '../workflow-program-context'
import { hasWorkflowRetryableCalls } from '../workflow-retry-eligibility'
import { GRAPH_PROGRAM_REVISION } from '../workflow-program-revisions'
import { assertGraphAttemptAdmissible, graphHasRetryableCalls } from './graph-checkpoint'

/**
 * Workflow graph runs through the real execution service, checkpoint store and journal, with a
 * fixture launcher standing in for the provider CLIs (no paid inference).
 */
const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const seat = (id: string, lineage: ResolvedLocalWorkflowSeat['lineage']) =>
  ({
    id,
    agent: 'claude',
    accountId: 'fixture',
    model: `claude-${id}`,
    effort: null,
    lineage,
    policyRevision: 'fixture-v1'
  }) as const

const spec = normalizeWorkflowSpec({
  title: 'Research',
  steps: [
    { id: 'research', kind: 'do', title: 'Research', agents: [{}, {}, {}] },
    { id: 'critics', kind: 'review', title: 'Critics', agents: [{}, {}], inputs: ['research'] },
    { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research', 'critics'] }
  ]
})

const snapshot: WorkflowProgramSnapshot = {
  version: 1,
  capability: { mode: 'frozen-analysis', revision: 1 },
  graphProgramRevision: GRAPH_PROGRAM_REVISION,
  graph: {
    spec,
    agentSeats: {
      research: ['a', 'b', 'c'],
      critics: ['b', 'c'],
      final: ['a']
    }
  },
  task: { prompt: 'How should we cache the build?', evidence: '' },
  seats: [seat('a', 'anthropic'), seat('b', 'openai'), seat('c', 'xai')],
  synthesizerId: 'a',
  limits: { concurrency: 4 }
}

type Responder = (
  call: WorkflowProgramCall,
  signal: AbortSignal
) => string | Error | Promise<string | Error>
function envelope(input: Parameters<WorkflowAttemptLaunch>[0], text: string) {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: input.attemptId,
    result: text,
    modelUsage: { [`claude-${input.call.seatId}`]: {} },
    usage: { input_tokens: 1, output_tokens: 1 }
  })
  return {
    result: { code: 0, signal: null, timedOut: false, stdout, stderr: '' },
    receipt: {
      attemptId: input.attemptId,
      processReceiptRef: input.attemptId,
      liveness: 'exited' as const
    }
  }
}

function setup(respond: { current: Responder }) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const launches: string[] = []
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(4),
    reservation: 1,
    attemptsPerRun: 2,
    progress: vi.fn(),
    launch: () => async (input) => {
      launches.push(input.call.id)
      input.recordLaunch(input.attemptId)
      const answer = await respond.current(input.call, input.signal)
      if (answer instanceof Error) {
        return {
          result: { code: 1, signal: null, timedOut: false, stdout: '', stderr: answer.message },
          receipt: {
            attemptId: input.attemptId,
            processReceiptRef: input.attemptId,
            liveness: 'exited' as const
          }
        }
      }
      return envelope(input, answer)
    }
  })
  const start = () =>
    service.start({
      conversationId: 'conversation',
      requestId: 'request',
      snapshot,
      preset: 'council',
      fence: 1,
      attemptLimit: 3,
      callLimit: 6,
      budgetLimit: 18
    })
  return { db, store, service, launches, start }
}

const healthy = (call: WorkflowProgramCall): string =>
  call.id.startsWith('critics')
    ? 'Response B overreaches.\nVERDICT: FAIL'
    : call.id.startsWith('final')
      ? 'Cache by lockfile hash.'
      : `Research from ${call.seatId}`

describe('workflow graph through the execution service', () => {
  it('completes and replays from the journal without launching anything', async () => {
    const respond = { current: healthy }
    const { service, launches, start } = setup(respond)
    const id = start()
    const outcome = await service.wait(id)
    expect(outcome).toMatchObject({
      state: 'completed',
      result: { final: { stepId: 'final', markdown: 'Cache by lockfile hash.' }, gaps: [] }
    })
    expect([...launches].sort()).toEqual([
      'critics/a0',
      'critics/a1',
      'final/a0',
      'research/a0',
      'research/a1',
      'research/a2'
    ])
    const before = launches.length
    const replayed = await service.recoverCompleted(id, 1)
    expect(replayed).toEqual(outcome)
    expect(launches.length).toBe(before)
  })

  it('completes with a named gap when one researcher keeps failing, trying it twice', async () => {
    const respond = {
      current: ((call) =>
        call.id === 'research/a1' ? new Error('timed out') : healthy(call)) as Responder
    }
    const { service, launches, start } = setup(respond)
    const outcome = await service.wait(start())
    expect(outcome).toMatchObject({
      state: 'completed',
      result: { gaps: ['Research: 1 agent call of 3 did not return a result.'] }
    })
    expect(launches.filter((call) => call === 'research/a1')).toHaveLength(2)
  })

  it('fails when a required step fails, then Retry runs only what failed', async () => {
    const respond = {
      current: ((call) =>
        call.id.startsWith('research') ? new Error('down') : healthy(call)) as Responder
    }
    const { db, store, service, launches, start } = setup(respond)
    const id = start()
    const failed = await service.wait(id)
    expect(failed).toMatchObject({
      state: 'failed',
      error: 'Research failed: none of its 3 agent calls returned a result.'
    })
    expect(launches.some((call) => !call.startsWith('research'))).toBe(false)
    expect(hasWorkflowRetryableCalls(db.db, id, 3)).toBe(true)
    // The provider recovers; Retry spends each failed call's last persisted attempt.
    respond.current = healthy
    store.retryFailed(id, 1)
    service.resume(id, 1)
    const retried = await service.wait(id)
    expect(retried).toMatchObject({ state: 'completed' })
    expect(launches.filter((call) => call.startsWith('research'))).toHaveLength(9)
    expect(launches.filter((call) => call === 'final/a0')).toHaveLength(1)
  })

  it('goes on without a review step that failed outright and says so', async () => {
    const respond = {
      current: ((call) =>
        call.id.startsWith('critics') ? 'No verdict here.' : healthy(call)) as Responder
    }
    const { service, start } = setup(respond)
    const outcome = await service.wait(start())
    expect(outcome).toMatchObject({
      state: 'completed',
      result: {
        final: { markdown: 'Cache by lockfile hash.' },
        gaps: [
          'Critics failed: none of its 2 agent calls returned a result. The steps after it went on without it.'
        ]
      }
    })
  })

  it('refuses a new attempt for a failure a later step was built without', async () => {
    const respond = {
      current: ((call) =>
        call.id === 'research/a2' ? new Error('down') : healthy(call)) as Responder
    }
    const { db, service, start } = setup(respond)
    const id = start()
    await service.wait(id)
    // research/a2 used 2 of its 3 attempts, but Critics already read Research without it.
    expect(() =>
      assertGraphAttemptAdmissible(db.db, { id, call_limit: 6 }, spec, 'research/a2', false)
    ).toThrow('A later step was already built without this result')
    expect(graphHasRetryableCalls(db.db, id, spec, 3)).toBe(false)
  })

  it('pauses mid-run and resumes without launching any call twice', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const respond = {
      current: (async (call) => {
        if (call.id === 'research/a0') {
          await gate
        }
        return healthy(call)
      }) as Responder
    }
    const { service, launches, start } = setup(respond)
    const id = start()
    await vi.waitFor(() => expect(launches).toContain('research/a0'))
    expect(service.control(id, 1, 'pause')).toBe('pausing')
    release()
    expect(await service.wait(id)).toMatchObject({ state: 'paused' })
    // Nothing after Research started while pausing.
    expect(launches.some((call) => !call.startsWith('research'))).toBe(false)
    service.resume(id, 1)
    expect(await service.wait(id)).toMatchObject({
      state: 'completed',
      result: { final: { markdown: 'Cache by lockfile hash.' }, gaps: [] }
    })
    expect([...launches].sort()).toEqual([
      'critics/a0',
      'critics/a1',
      'final/a0',
      'research/a0',
      'research/a1',
      'research/a2'
    ])
  })

  it('stops a run: the running call ends, nothing after it launches, and the run is cancelled', async () => {
    const respond = {
      current: (async (call, signal) =>
        call.id === 'research/a1'
          ? // Like the real launcher: a stopped attempt's process is killed and exits.
            new Promise<Error>((resolve) =>
              signal.addEventListener('abort', () => resolve(new Error('killed')), { once: true })
            )
          : healthy(call)) as Responder
    }
    const { db, service, launches, start } = setup(respond)
    const id = start()
    await vi.waitFor(() => expect(launches).toContain('research/a1'))
    service.control(id, 1, 'stop')
    expect(await service.wait(id)).toMatchObject({ state: 'cancelled' })
    expect(launches.some((call) => !call.startsWith('research'))).toBe(false)
    const open = db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM local_workflow_attempts WHERE state IN ('prepared','running')"
      )
      .get() as { count: number }
    expect(open.count).toBe(0)
  })
})
