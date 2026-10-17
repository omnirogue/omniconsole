import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowFinishReserve } from '../../../../shared/workflow-graph-topology'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import { WorkflowCheckpointStore } from '../workflow-checkpoint-store'
import { WorkflowScriptSlots } from '../workflow-script-slots'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from '../workflow-execution-service'
import type { WorkflowAttemptLaunch } from '../workflow-durable-call'
import type { WorkflowProgramCall } from '../workflow-program-context'
import { GRAPH_PROGRAM_REVISION } from '../workflow-program-revisions'
import { projectLocalWorkflow } from '../local-workflow-projection'
import { GRAPH_FINISHING_REFUSAL, graphAdmissionClosed } from './graph-checkpoint'

/**
 * Finish now and Max agents through the real execution service, checkpoint store and projection,
 * with a fixture launcher standing in for the provider CLIs.
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

const snapshot = (concurrency: number): WorkflowProgramSnapshot =>
  ({
    version: 1,
    capability: { mode: 'frozen-analysis', revision: 1 },
    graphProgramRevision: GRAPH_PROGRAM_REVISION,
    graph: {
      spec,
      agentSeats: { research: ['a', 'b', 'c'], critics: ['b', 'c'], final: ['a'] }
    },
    task: { prompt: 'How should we cache the build?', evidence: '' },
    seats: [seat('a', 'anthropic'), seat('b', 'openai'), seat('c', 'xai')],
    synthesizerId: 'a',
    limits: { concurrency },
    host: { startedAt: 1, sources: [], coverage: [] }
  }) as WorkflowProgramSnapshot

type Responder = (call: WorkflowProgramCall) => string | Promise<string>

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

const healthy = (call: WorkflowProgramCall): string =>
  call.id.startsWith('critics')
    ? 'Response B overreaches.\nVERDICT: FAIL'
    : call.id.startsWith('final')
      ? 'Cache by lockfile hash.'
      : `Research from ${call.seatId}`

function setup(respond: Responder, options: { concurrency: number; callLimit?: number }) {
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
      return envelope(input, await respond(input.call))
    }
  })
  const callLimit = options.callLimit ?? 6
  const id = service.start({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: snapshot(options.concurrency),
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit,
    budgetLimit: callLimit * 3
  })
  const view = () =>
    projectLocalWorkflow({ db: db.db, store, executionId: id, active: service.isActive(id) })
  const callLimitNow = () =>
    (
      db.db.prepare('SELECT call_limit FROM local_workflow_executions WHERE id=?').get(id) as {
        call_limit: number
      }
    ).call_limit
  return { db, store, service, launches, id, view, callLimitNow }
}

describe('workflow graph Finish now and Max agents', () => {
  it('reserves the final step, and only for a workflow with one final step outside a loop', () => {
    expect(workflowFinishReserve(spec)).toEqual({ finalStepId: 'final', reserve: 1 })
    expect(graphAdmissionClosed(spec, 6, ['research/a0', 'research/a1'])).toBe(false)
    expect(graphAdmissionClosed(spec, 3, ['research/a0', 'research/a1'])).toBe(true)
    // The final step's own records never close admission for the rest.
    expect(graphAdmissionClosed(spec, 3, ['research/a0', 'final/a0'])).toBe(false)
    // An uncapped run that recorded every other call is not finishing.
    const everyOther = ['research/a0', 'research/a1', 'research/a2', 'critics/a0', 'critics/a1']
    expect(graphAdmissionClosed(spec, 6, everyOther)).toBe(false)
    // A skipped revision would leave an approval loop nothing to report.
    const approved = normalizeWorkflowSpec({
      title: 'Draft',
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{}] },
        { id: 'review', kind: 'review', title: 'Review', agents: [{}], inputs: ['draft'] },
        { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['draft', 'review'] }
      ],
      repeat: { do: 'draft', review: 'review', until: 'approved', maxRounds: 3 }
    })
    expect(workflowFinishReserve(approved)).toBeUndefined()
    // One surviving answer leaves a final Rank nothing to rank.
    const ranked = normalizeWorkflowSpec({
      title: 'Best of three',
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{}, {}, {}] },
        { id: 'rank', kind: 'rank', title: 'Rank', agents: [{}, {}], inputs: ['draft'] }
      ]
    })
    expect(workflowFinishReserve(ranked)).toBeUndefined()
    const looped = normalizeWorkflowSpec({
      title: 'Improve',
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{}] },
        { id: 'rank', kind: 'rank', title: 'Rank', agents: [{}, {}], inputs: ['draft'] }
      ],
      repeat: { do: 'draft', review: 'rank', until: 'plateau', maxRounds: 3 }
    })
    expect(workflowFinishReserve(looped)).toBeUndefined()
  })

  it('Finish now: the agent at work finishes, nothing else starts, and the final step reports', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = setup(
      async (call) => {
        if (call.id === 'research/a0') {
          await gate
        }
        return healthy(call)
      },
      { concurrency: 1 }
    )
    await vi.waitFor(() => expect(f.launches).toEqual(['research/a0']))
    expect(f.view()).toMatchObject({ state: 'running', canFinish: true })
    expect(f.view().finishing).toBeUndefined()

    expect(f.service.control(f.id, 1, 'finish')).toBe('running')
    // One research record plus the final step's reserved call.
    expect(f.callLimitNow()).toBe(2)
    expect(f.view()).toMatchObject({ finishing: true })
    expect(f.view().canFinish).toBeUndefined()
    // Finish never raises the limit again.
    f.service.control(f.id, 1, 'finish')
    expect(f.callLimitNow()).toBe(2)

    release()
    const outcome = await f.service.wait(f.id)
    expect(outcome).toMatchObject({
      state: 'completed',
      result: { final: { stepId: 'final', markdown: 'Cache by lockfile hash.' } }
    })
    expect(f.launches).toEqual(['research/a0', 'final/a0'])
    expect(outcome.result).toMatchObject({
      gaps: [
        'Research: 2 agent calls of 3 were skipped: the run finished early.',
        'Critics: Critics was skipped: the run finished early.'
      ]
    })
    const settled = f.view()
    expect(settled).toMatchObject({ state: 'completed' })
    expect(settled.finishing).toBeUndefined()
    expect(settled.result?.markdown).toContain('Cache by lockfile hash.')
    expect(settled.graphRun?.gaps).toEqual((outcome.result as { gaps: string[] }).gaps)
    // After a restart the completed run replays from its records to the same result.
    const before = f.launches.length
    expect(await f.service.recoverCompleted(f.id, 1)).toEqual(outcome)
    expect(f.launches.length).toBe(before)
  })

  it('a Do step that never started does not block the steps after it', async () => {
    const chain = normalizeWorkflowSpec({
      title: 'Chain',
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{}] },
        { id: 'expand', kind: 'do', title: 'Expand', agents: [{}, {}], inputs: ['draft'] },
        { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['draft', 'expand'] }
      ]
    })
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const store = new WorkflowCheckpointStore(db.db)
    const launches: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = new WorkflowExecutionService({
      store,
      slots: new WorkflowScriptSlots(4),
      reservation: 1,
      attemptsPerRun: 2,
      progress: vi.fn(),
      launch: () => async (input) => {
        launches.push(input.call.id)
        input.recordLaunch(input.attemptId)
        if (input.call.id === 'draft/a0') {
          await gate
        }
        return envelope(input, input.call.id.startsWith('final') ? 'Done.' : 'Draft text')
      }
    })
    const id = service.start({
      conversationId: 'conversation',
      requestId: 'request',
      snapshot: {
        ...snapshot(4),
        graph: { spec: chain, agentSeats: { draft: ['a'], expand: ['b', 'c'], final: ['a'] } }
      } as WorkflowProgramSnapshot,
      preset: 'council',
      fence: 1,
      attemptLimit: 3,
      callLimit: 4,
      budgetLimit: 12
    })
    await vi.waitFor(() => expect(launches).toEqual(['draft/a0']))
    service.control(id, 1, 'finish')
    release()
    expect(await service.wait(id)).toMatchObject({
      state: 'completed',
      result: {
        final: { markdown: 'Done.' },
        gaps: ['Expand: Expand was skipped: the run finished early.']
      }
    })
    expect(launches).toEqual(['draft/a0', 'final/a0'])
  })

  it('Max agents: the run stops starting agents at the cap and still reports', async () => {
    // A cap of 3 keeps one call for the final step, so two research agents run.
    const f = setup(healthy, { concurrency: 4, callLimit: 3 })
    const outcome = await f.service.wait(f.id)
    expect(outcome).toMatchObject({
      state: 'completed',
      result: { final: { markdown: 'Cache by lockfile hash.' } }
    })
    expect(f.launches.filter((call) => call.startsWith('research'))).toHaveLength(2)
    expect(f.launches.filter((call) => call.startsWith('critics'))).toHaveLength(0)
    expect(f.launches).toContain('final/a0')
    const records = f.db.db.prepare('SELECT COUNT(*) AS count FROM local_workflow_calls').get() as {
      count: number
    }
    expect(records.count).toBe(3)
  })

  it('refuses a new call outside the final step once finishing, but admits the final step', async () => {
    const f = setup(healthy, { concurrency: 4, callLimit: 3 })
    await f.service.wait(f.id)
    expect(() =>
      f.store.prepare({
        executionId: f.id,
        fence: 1,
        callId: 'critics/a0',
        inputDigest: 'x',
        reservation: 0,
        validate: () => {}
      })
    ).toThrow()
    // The refusal names the reason when the run can still admit work.
    const g = setup(
      () =>
        new Promise<string>(() => {
          /* never settles: the run stays active */
        }),
      { concurrency: 1 }
    )
    await vi.waitFor(() => expect(g.launches).toEqual(['research/a0']))
    g.service.control(g.id, 1, 'finish')
    expect(() =>
      g.store.prepare({
        executionId: g.id,
        fence: 1,
        callId: 'research/a1',
        inputDigest: 'x',
        reservation: 0,
        validate: () => {}
      })
    ).toThrow(GRAPH_FINISHING_REFUSAL)
    expect(
      g.store.prepare({
        executionId: g.id,
        fence: 1,
        callId: 'final/a0',
        inputDigest: 'x',
        reservation: 0,
        validate: () => {}
      })
    ).toMatchObject({ ordinal: 1 })
  })

  it('finishes a paused run by resuming it straight into the final step', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = setup(
      async (call) => {
        if (call.id === 'research/a0') {
          await gate
        }
        return healthy(call)
      },
      { concurrency: 1 }
    )
    await vi.waitFor(() => expect(f.launches).toEqual(['research/a0']))
    f.service.control(f.id, 1, 'pause')
    release()
    expect(await f.service.wait(f.id)).toMatchObject({ state: 'paused' })
    expect(f.view()).toMatchObject({ state: 'paused', canFinish: true })
    const stepStates = () =>
      Object.fromEntries(
        (f.view().graphRun?.steps ?? []).map((step) => [step.id, step.rounds.at(-1)?.state])
      )
    expect(stepStates()).toEqual({ research: 'running', critics: 'waiting', final: 'waiting' })
    f.service.control(f.id, 1, 'finish')
    // The view plans the refused calls as skipped, exactly as the program will.
    expect(stepStates()).toEqual({ research: 'gaps', critics: 'empty', final: 'running' })
    f.service.resume(f.id, 1)
    expect(await f.service.wait(f.id)).toMatchObject({
      state: 'completed',
      result: { final: { markdown: 'Cache by lockfile hash.' } }
    })
    expect(f.launches).toEqual(['research/a0', 'final/a0'])
  })
})
