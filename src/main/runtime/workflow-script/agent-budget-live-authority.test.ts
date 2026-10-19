import { afterEach, describe, expect, it } from 'vitest'
import { AgentBudgetClient } from './agent-budget-client'
import { WorkflowCallBudget, type WorkflowBudgetRefusedError } from './workflow-call-budget'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { createDurableWorkflowAgent } from './workflow-durable-call'
import { WorkflowScriptSlots } from './workflow-script-slots'

/**
 * Against a real OmniSI authority (omnidots-cloud migration 0115 on Postgres), started by a
 * harness that seeds an internal research org, a budget:write key and a $1 root with $0.90
 * already settled. Skipped unless OMNISI_AGENT_BUDGET_LIVE_URL is set; never calls a model.
 */
const url = process.env.OMNISI_AGENT_BUDGET_LIVE_URL
const key = process.env.OMNISI_AGENT_BUDGET_LIVE_KEY ?? ''
const rootId = process.env.OMNISI_AGENT_BUDGET_LIVE_ROOT ?? ''
const model = process.env.OMNISI_AGENT_BUDGET_LIVE_MODEL ?? 'test-model'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const host = (name: string) => new AgentBudgetClient({ url: url ?? '', key, host: name })
const bounds = { rootId, benchmark: false, maxInputTokens: 60_000, maxOutputTokens: 8_000 }

describe.skipIf(!url)('the real OmniSI budget authority', () => {
  it('two desktops asking for $0.08 against $0.10 left: exactly one is admitted', async () => {
    const studio = new WorkflowCallBudget(host('mac-studio'), bounds, 'run-studio')
    const fleet = new WorkflowCallBudget(host('mw0001'), bounds, 'run-fleet')
    const ask = (budget: WorkflowCallBudget, id: string) =>
      budget
        .admit({
          attemptId: crypto.randomUUID(),
          callId: `find:${id}`,
          route: 'claude',
          model,
          signal: new AbortController().signal
        })
        .then(
          (grant) => ({ admitted: grant.reservedUsd }),
          (error: WorkflowBudgetRefusedError) => ({ refused: error.code })
        )
    const results = await Promise.all([ask(studio, 'a'), ask(fleet, 'b')])
    expect(results).toContainEqual({ admitted: 0.08 })
    expect(results).toContainEqual({ refused: 'budget_exhausted' })
    const view = await host('mac-studio').view(rootId)
    expect(view?.exposure_micros).toBe(980_000)
  })

  it('a workflow call refused by the authority launches nothing', async () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const store = new WorkflowCheckpointStore(db.db)
    const executionId = store.create({
      conversationId: 'c',
      requestId: 'r',
      snapshot: {},
      preset: 'council',
      fence: 1,
      attemptLimit: 3,
      callLimit: 7,
      budgetLimit: 30
    })
    let launches = 0
    const controller = new AbortController()
    const agent = createDurableWorkflowAgent({
      store,
      executionId,
      fence: 1,
      slots: new WorkflowScriptSlots(1),
      signal: controller.signal,
      reservation: 1,
      seatFingerprint: () => 'claude',
      route: () => 'claude',
      budget: new WorkflowCallBudget(host('mac-studio'), bounds, executionId),
      budgetSeat: () => ({ model }),
      launch: async () => {
        launches++
        throw new Error('never')
      },
      closeAdmission: (error) => controller.abort(error)
    })
    await expect(
      agent({
        id: 'find:c',
        seatId: 'a',
        prompt: 'q',
        dependencies: [],
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false
        },
        validateSemantics: () => null
      })
    ).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect(launches).toBe(0)
  })

  it('a Stop from OmniConsole revokes the root for every product', async () => {
    expect(await host('mac-studio').stop(rootId, 'Stopped in OmniConsole (live check)')).toBe(
      'stopped'
    )
    const after = await host('mw0001').admit({
      attempt_id: crypto.randomUUID(),
      root_id: rootId,
      run_id: 'run-after-stop',
      product: 'omniconsole',
      execution_host: 'mw0001',
      stage: 'find',
      call_key: 'after-stop',
      provider: 'claude-cli',
      model,
      max_input_tokens: 1,
      max_output_tokens: 1
    })
    expect(after).toMatchObject({ decision: 'refused', code: 'stopped' })
  })
})
