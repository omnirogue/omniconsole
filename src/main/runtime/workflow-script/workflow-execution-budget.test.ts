import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowScriptSlots } from './workflow-script-slots'
import {
  WorkflowExecutionService,
  type WorkflowProgramSnapshot
} from './workflow-execution-service'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import { fakeBudgetAuthority } from './agent-budget.test-fixtures'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

// Every seat runs on Claude (the route the budget can hold to a reservation); Council's
// three-lineage rule is met with fixture lineages so the run itself is the subject here.
const seat = (id: string, lineage: 'anthropic' | 'openai' | 'xai') => ({
  id,
  agent: 'claude' as const,
  accountId: `${id}-account`,
  model: 'claude-model',
  effort: 'low',
  lineage,
  policyRevision: 'fixture-v1'
})

function snapshot(rootId: string): WorkflowProgramSnapshot {
  return {
    version: 1,
    task: { prompt: 'Question', evidence: 'Frozen evidence' },
    synthesizerId: 'one',
    seats: [seat('one', 'anthropic'), seat('two', 'openai'), seat('three', 'xai')],
    councilProgramRevision: 4,
    budget: { rootId, benchmark: false, maxInputTokens: 60_000, maxOutputTokens: 8_000 },
    discover: {
      dimensions: ['correctness', 'security', 'usability'],
      lenses: ['evidence', 'alternatives'],
      minimumSeverity: 'medium',
      maxCandidates: 12
    }
  }
}

function native(input: Parameters<WorkflowAttemptLaunch>[0], seats: string[]) {
  const { call, attemptId } = input
  const labels = ['Response A', 'Response B', 'Response C'].filter(
    (_, index) => seats[index] !== call.seatId
  )
  const value = call.id.startsWith('peer/')
    ? {
        ranking: labels,
        assessments: labels.map((label) => ({ label, strengths: 'S', weaknesses: 'W' }))
      }
    : {
        markdown: 'Supported answer',
        sources: [],
        ...(call.id.startsWith('answers/') ? { uncertainties: [] } : { disagreements: [] })
      }
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
        session_id: attemptId,
        structured_output: value,
        modelUsage: { 'claude-model': {} },
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.01
      })
    },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}

function setup(
  authority: ReturnType<typeof fakeBudgetAuthority> | undefined,
  before?: (input: Parameters<WorkflowAttemptLaunch>[0]) => Promise<void> | void,
  db = new OrchestrationDb(':memory:')
) {
  if (!databases.includes(db)) {
    databases.push(db)
  }
  const store = new WorkflowCheckpointStore(db.db)
  const launches: { id: string; budget?: { reservedUsd: number } }[] = []
  const messages: string[] = []
  const service = new WorkflowExecutionService({
    store,
    slots: new WorkflowScriptSlots(1),
    reservation: 1,
    progress: (_id, event) => {
      if (event.message) {
        messages.push(event.message)
      }
    },
    budgetWatchMs: 5,
    ...(authority ? { budgetAuthority: authority.client } : {}),
    launch: () => async (input) => {
      launches.push({ id: input.call.id, budget: input.budget })
      input.recordLaunch(input.attemptId)
      await before?.(input)
      return native(input, ['one', 'two', 'three'])
    }
  })
  const request = (requestId: string, rootId: string) => ({
    conversationId: 'conversation',
    requestId,
    snapshot: snapshot(rootId),
    preset: 'council' as const,
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 21
  })
  return { db, store, service, launches, request, messages }
}

describe('budgeted workflow executions', () => {
  it('every launch of a run is admitted and settled against its root', async () => {
    const authority = fakeBudgetAuthority({ ceilingMicros: 5_000_000 })
    const f = setup(authority)
    const id = f.service.start(f.request('first', authority.rootId))
    expect(await f.service.wait(id)).toMatchObject({ state: 'completed' })
    expect(f.launches.length).toBeGreaterThan(0)
    expect(f.launches.every((launch) => launch.budget?.reservedUsd === 0.08)).toBe(true)
    const paths = authority.state.requests.map((r) => r.path.split('/').pop())
    expect(paths.filter((p) => p === 'admit')).toHaveLength(f.launches.length)
    expect(paths.filter((p) => p === 'settle')).toHaveLength(f.launches.length)
    expect(authority.exposure()).toBe(10_000 * f.launches.length)
    // Where the root stands before and after, read from the ledger, never a model call.
    expect(f.messages).toEqual([
      'Budget before this run: Committed $0.00 of $5.00.',
      `Budget after this run: Committed $${((10_000 * f.launches.length) / 1_000_000).toFixed(2)} of $5.00.`
    ])
  })

  it('a budgeted run on a computer without the authority fails before any call', async () => {
    const f = setup(undefined)
    const id = f.service.start(f.request('first', '11111111-1111-4111-8111-111111111111'))
    const outcome = await f.service.wait(id)
    expect(outcome.state).toBe('failed')
    expect(outcome.error).toMatch(/authority_unavailable/)
    expect(f.launches).toEqual([])
  })

  it('an exhausted root ends the run with what it has and launches nothing more', async () => {
    // $0.10: each call reserves $0.08 and settles at $0.01, so three fit and the fourth does not.
    const authority = fakeBudgetAuthority({ ceilingMicros: 100_000, perCallMicros: 80_000 })
    const f = setup(authority)
    const id = f.service.start(f.request('first', authority.rootId))
    const outcome = await f.service.wait(id)
    expect(outcome.state).not.toBe('completed')
    expect(f.launches).toHaveLength(3)
    expect(authority.state.attempts.size).toBe(3)
    expect(authority.exposure()).toBe(30_000)
    const refused = authority.state.requests.filter((r) => r.path.endsWith('/admit'))
    expect(refused).toHaveLength(4)
  })

  it('a manual stop revokes the root, so a restarted app cannot spend it again', async () => {
    const authority = fakeBudgetAuthority({ ceilingMicros: 5_000_000 })
    const db = new OrchestrationDb(':memory:')
    let stopped = false
    const f = setup(
      authority,
      () => {
        if (!stopped) {
          stopped = true
          f.service.control(id, 1, 'stop')
        }
      },
      db
    )
    const id = f.service.start(f.request('first', authority.rootId))
    expect((await f.service.wait(id)).state).toBe('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(authority.state.root.state).toBe('stopped')
    expect(f.launches).toHaveLength(1)
    // The in-flight call was still settled: it may have spent its reservation.
    expect(authority.state.requests.filter((r) => r.path.endsWith('/settle'))).toHaveLength(1)
    // "Restart": a new service on the same database, and a replayed or new Start on that root.
    const restarted = setup(authority, undefined, db)
    const again = restarted.service.start(restarted.request('second', authority.rootId))
    expect((await restarted.service.wait(again)).state).not.toBe('completed')
    expect(restarted.launches).toEqual([])
  })

  it('a root stopped in OmniSI or on another computer ends the run here too', async () => {
    const authority = fakeBudgetAuthority({ ceilingMicros: 5_000_000 })
    const f = setup(authority, async () => {
      authority.state.root.state = 'stopped'
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const id = f.service.start(f.request('first', authority.rootId))
    expect(['cancelled', 'failed']).toContain((await f.service.wait(id)).state)
    expect(f.launches).toHaveLength(1)
  })
})
