import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import {
  createDurableWorkflowAgent,
  WorkflowAttemptUnverifiableError,
  WorkflowNoLaunchError,
  type WorkflowAttemptLaunch
} from './workflow-durable-call'
import { WorkflowScriptSlots } from './workflow-script-slots'
import type { WorkflowProgramCall } from './workflow-program-context'
import { WorkflowBudgetRefusedError, WorkflowCallBudget } from './workflow-call-budget'
import { fakeBudgetAuthority } from './agent-budget.test-fixtures'
import { AgentBudgetClient, resolveAgentBudgetConfig } from './agent-budget-client'
import { admitWorkflowBudget } from './local-workflow-budget-admission'
import {
  buildWorkflowClaudeArgs,
  buildWorkflowClaudeStreamArgs,
  workflowClaudeBudgetArgs
} from '../../../shared/workflow-claude-command'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const call: WorkflowProgramCall = {
  id: 'find:1',
  seatId: 'a',
  prompt: 'Frozen question',
  dependencies: [],
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false
  },
  validateSemantics: (value) =>
    (value as { answer: string }).answer === 'correct' ? null : 'unsupported answer'
}

function response(attemptId: string, value: unknown, costUsd?: number) {
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
        usage: { input_tokens: 1200, output_tokens: 300 },
        ...(costUsd === undefined ? {} : { total_cost_usd: costUsd })
      })
    },
    receipt: { attemptId, processReceiptRef: attemptId, liveness: 'exited' as const }
  }
}

function setup(
  launch: WorkflowAttemptLaunch,
  authority = fakeBudgetAuthority(),
  route: LocalWorkflowRoute = 'claude'
) {
  const database = new OrchestrationDb(':memory:')
  databases.push(database)
  const store = new WorkflowCheckpointStore(database.db)
  const executionId = store.create({
    conversationId: 'conversation',
    requestId: 'request',
    snapshot: {},
    preset: 'council',
    fence: 1,
    attemptLimit: 3,
    callLimit: 7,
    budgetLimit: 30
  })
  const controller = new AbortController()
  const closed: Error[] = []
  const budget = new WorkflowCallBudget(
    authority.client,
    { rootId: authority.rootId, benchmark: false, maxInputTokens: 60_000, maxOutputTokens: 8_000 },
    executionId
  )
  const config = {
    store,
    executionId,
    fence: 1,
    slots: new WorkflowScriptSlots(2),
    signal: controller.signal,
    reservation: 1,
    attemptsPerRun: 2,
    seatFingerprint: () => 'claude:claude-opus-5-5:high:seat-a',
    route: () => route,
    budget,
    budgetSeat: () => ({ model: 'claude-opus-5-5', effort: 'high', accountId: 'seat-a' }),
    launch,
    closeAdmission: (error: Error) => {
      closed.push(error)
      controller.abort(error)
    }
  }
  return { database, store, config, authority, closed, agent: createDurableWorkflowAgent(config) }
}

function attempts(f: ReturnType<typeof setup>) {
  return f.database.db
    .prepare('SELECT state, receipt_json FROM local_workflow_attempts ORDER BY ordinal')
    .all() as { state: string; receipt_json: string | null }[]
}

describe('budgeted workflow calls', () => {
  it('admits before launch, caps Claude at the reservation and settles the billed cost once', async () => {
    const launches: { budget?: { reservedUsd: number } }[] = []
    const f = setup(async ({ attemptId, recordLaunch, budget }) => {
      launches.push({ budget })
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'correct' }, 0.0421)
    })
    expect(await f.agent(call)).toEqual({ answer: 'correct' })
    expect(launches).toEqual([{ budget: { reservedUsd: 0.08 } }])
    const [admit, settle] = f.authority.state.requests
    expect(admit.path).toBe('/api/v1/agent-budget/admit')
    expect(admit.body).toMatchObject({
      root_id: f.authority.rootId,
      product: 'omniconsole',
      execution_host: 'test-host',
      stage: 'find',
      provider: 'claude-cli',
      model: 'claude-opus-5-5',
      effort: 'high',
      account_ref: 'seat-a',
      max_input_tokens: 60_000,
      max_output_tokens: 8_000
    })
    // The authority's attempt is the local attempt: one id, settled once with Claude's own bill.
    expect(settle.body).toMatchObject({
      attempt_id: admit.body.attempt_id,
      outcome: 'ok',
      cost_micros: 42_100,
      input_tokens: 1200,
      output_tokens: 300
    })
    expect(f.authority.exposure()).toBe(42_100)
    // Replaying the saved output asks no one and launches nothing; it is recorded as reuse.
    expect(await createDurableWorkflowAgent(f.config)(call)).toEqual({ answer: 'correct' })
    expect(launches).toHaveLength(1)
    expect(f.authority.state.reuses).toHaveLength(1)
    expect(f.authority.state.reuses[0]).toMatchObject({
      call_key: expect.stringContaining('find:1')
    })
  })

  it('a refused admission launches nothing and stops the run', async () => {
    let launches = 0
    const authority = fakeBudgetAuthority({ ceilingMicros: 50_000 })
    const f = setup(async () => {
      launches++
      throw new Error('never')
    }, authority)
    await expect(f.agent(call)).rejects.toMatchObject({
      name: 'WorkflowBudgetRefusedError',
      code: 'budget_exhausted'
    })
    expect(launches).toBe(0)
    expect(f.closed[0]).toBeInstanceOf(WorkflowBudgetRefusedError)
    const [row] = attempts(f)
    expect(JSON.parse(row.receipt_json!)).toMatchObject({ noLaunch: true })
  })

  it('an unreachable authority is a refusal, never a local balance', async () => {
    let launches = 0
    const f = setup(
      async () => {
        launches++
        throw new Error('never')
      },
      fakeBudgetAuthority({ down: true })
    )
    await expect(f.agent(call)).rejects.toMatchObject({ code: 'authority_unavailable' })
    expect(launches).toBe(0)
  })

  it('routes that cannot be held to a reservation are refused without asking', async () => {
    let launches = 0
    const f = setup(
      async () => {
        launches++
        throw new Error('never')
      },
      fakeBudgetAuthority(),
      'codex'
    )
    await expect(f.agent(call)).rejects.toMatchObject({ code: 'adapter_unsupported' })
    expect(launches).toBe(0)
    expect(f.authority.state.requests).toEqual([])
  })

  it('a lost attempt keeps its reservation; one that never launched releases it', async () => {
    const lost = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      throw new Error('lost process handle')
    })
    await expect(lost.agent(call)).rejects.toBeInstanceOf(WorkflowAttemptUnverifiableError)
    const settle = lost.authority.state.requests.find((r) => r.path.endsWith('/settle'))!
    expect(settle.body).toEqual({ attempt_id: expect.any(String), outcome: 'unknown' })
    expect(lost.authority.exposure()).toBe(80_000)

    let tries = 0
    const unsent = setup(async ({ attemptId, recordLaunch, recordNoLaunch }) => {
      tries++
      if (tries === 1) {
        recordNoLaunch('the seat refused to start')
        throw new WorkflowNoLaunchError('the seat refused to start')
      }
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'correct' }, 0.01)
    })
    expect(await unsent.agent(call)).toEqual({ answer: 'correct' })
    expect(unsent.authority.state.requests.map((r) => r.path.split('/').pop())).toEqual([
      'admit',
      'release',
      'admit',
      'settle'
    ])
    expect(unsent.authority.exposure()).toBe(10_000)
  })

  it('a failed attempt is still billed and the retry is another attempt', async () => {
    const f = setup(async ({ attemptId, ordinal, recordLaunch }) => {
      recordLaunch(attemptId)
      return response(attemptId, { answer: ordinal === 1 ? 'wrong' : 'correct' }, 0.02)
    })
    expect(await f.agent(call)).toEqual({ answer: 'correct' })
    const settles = f.authority.state.requests.filter((r) => r.path.endsWith('/settle'))
    expect(settles.map((r) => r.body)).toMatchObject([
      { outcome: 'failed', cost_micros: 20_000 },
      { outcome: 'ok', cost_micros: 20_000 }
    ])
    expect(f.authority.state.attempts.size).toBe(2)
  })

  it('without a reported cost the settlement stays unknown', async () => {
    const f = setup(async ({ attemptId, recordLaunch }) => {
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'correct' })
    })
    await f.agent(call)
    const settle = f.authority.state.requests.find((r) => r.path.endsWith('/settle'))!
    expect(settle.body).toMatchObject({ outcome: 'unknown', input_tokens: 1200 })
    expect(settle.body).not.toHaveProperty('cost_micros')
    expect(f.authority.exposure()).toBe(80_000)
  })

  it('a stopped root refuses the next call from any host', async () => {
    let launches = 0
    const f = setup(async ({ attemptId, recordLaunch }) => {
      launches++
      recordLaunch(attemptId)
      return response(attemptId, { answer: 'correct' }, 0.01)
    })
    await f.agent(call)
    // Someone stops the root in OmniSI (or on another computer).
    await f.authority.client.stop(f.authority.rootId, 'Sal pressed stop')
    await expect(f.agent({ ...call, id: 'find:2' })).rejects.toMatchObject({ code: 'stopped' })
    expect(launches).toBe(1)
  })
})

describe('budget Start admission', () => {
  const claudeSeat = {
    id: 'a',
    agent: 'claude' as const,
    accountId: 'seat-a',
    model: 'claude-opus-5-5',
    effort: 'high',
    lineage: 'anthropic' as never,
    policyRevision: 'p'
  }

  it('freezes the root, takes the benchmark mark from the root and refuses other routes', async () => {
    const research = fakeBudgetAuthority()
    expect(
      await admitWorkflowBudget({
        rootId: research.rootId,
        snapshot: { seats: [claudeSeat] },
        authority: research.client
      })
    ).toEqual({
      rootId: research.rootId,
      benchmark: false,
      maxInputTokens: 60_000,
      maxOutputTokens: 8_000
    })
    const bench = fakeBudgetAuthority({ kind: 'benchmark' })
    expect(
      (
        await admitWorkflowBudget({
          rootId: bench.rootId,
          snapshot: { seats: [claudeSeat] },
          authority: bench.client
        })
      )?.benchmark
    ).toBe(true)
    await expect(
      admitWorkflowBudget({
        rootId: research.rootId,
        snapshot: { seats: [claudeSeat, { ...claudeSeat, id: 'b', agent: 'codex' }] },
        authority: research.client
      })
    ).rejects.toThrow(/Claude seats only; codex/)
  })

  it('an enforcing computer refuses a Start without a root, a closed root and no authority', async () => {
    const authority = fakeBudgetAuthority()
    await expect(
      admitWorkflowBudget({ snapshot: { seats: [claudeSeat] }, authority: authority.client })
    ).rejects.toThrow(/--budget-root/)
    await authority.client.stop(authority.rootId, 'done')
    await expect(
      admitWorkflowBudget({
        rootId: authority.rootId,
        snapshot: { seats: [claudeSeat] },
        authority: authority.client
      })
    ).rejects.toThrow(/stopped/)
    await expect(
      admitWorkflowBudget({ rootId: authority.rootId, snapshot: { seats: [claudeSeat] } })
    ).rejects.toThrow(/no agent budget authority/)
    // Not enforcing and not asked: unchanged.
    expect(await admitWorkflowBudget({ snapshot: { seats: [claudeSeat] } })).toBeUndefined()
  })
})

describe('budget configuration and the Claude cap', () => {
  it('is off unless enforcement is switched on, and refuses everything when half-configured', async () => {
    expect(await resolveAgentBudgetConfig({}, 'h')).toBeUndefined()
    const half = await resolveAgentBudgetConfig({ OMNI_AGENT_BUDGET_ENFORCE: 'true' }, 'h')
    expect(half).toMatchObject({ url: '', host: 'h' })
    const client = new AgentBudgetClient(half!)
    expect(await client.admit({} as never)).toEqual({
      decision: 'refused',
      code: 'authority_unavailable'
    })
    const plain = await resolveAgentBudgetConfig(
      {
        OMNI_AGENT_BUDGET_ENFORCE: 'true',
        OMNISI_AGENT_BUDGET_URL: 'http://omnisi.example',
        OMNISI_AGENT_BUDGET_KEY: 'osi_api1.org.secret-secret-secret'
      },
      'h'
    )
    // Never over plain HTTP to a remote host: the key would travel in clear text.
    expect(plain?.url).toBe('')
  })

  it('passes the reservation to Claude, rounded down to the cent', () => {
    expect(workflowClaudeBudgetArgs(undefined)).toEqual([])
    expect(workflowClaudeBudgetArgs(0.0899)).toEqual(['--max-budget-usd', '0.08'])
    expect(() => workflowClaudeBudgetArgs(0)).toThrow()
    const frozen = buildWorkflowClaudeArgs({
      model: 'claude-opus-5-5',
      attemptId: 'a1',
      schema: call.schema,
      maxBudgetUsd: 1.5
    })
    expect(
      frozen.slice(frozen.indexOf('--max-budget-usd'), frozen.indexOf('--max-budget-usd') + 2)
    ).toEqual(['--max-budget-usd', '1.50'])
    const streamed = buildWorkflowClaudeStreamArgs({
      model: 'claude-opus-5-5',
      attemptId: 'a1',
      access: 'frozen',
      maxBudgetUsd: 0.64
    })
    expect(streamed).toContain('0.64')
    expect(
      buildWorkflowClaudeStreamArgs({ model: 'm', attemptId: 'a', access: 'frozen' })
    ).not.toContain('--max-budget-usd')
  })
})
