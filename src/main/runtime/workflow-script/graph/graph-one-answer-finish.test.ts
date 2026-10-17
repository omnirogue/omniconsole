import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  workflowFinishReserve,
  workflowTerminalCall
} from '../../../../shared/workflow-graph-topology'
import {
  assertGraphAttemptAdmissible,
  graphAdmissionClosed,
  graphFinishState,
  GRAPH_FINISHING_REFUSAL
} from './graph-checkpoint'
import { planWorkflowGraph } from './graph-plan'
import type { GraphCall, GraphOutcome } from './graph-plan-types'
import { configFor, task, text } from './graph-test-harness'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const SPEC: WorkflowSpec = {
  version: 1,
  title: 'Routed',
  template: 'custom',
  oneAnswer: { step: 'direct' },
  steps: [
    {
      id: 'direct',
      kind: 'do',
      title: 'One answer',
      instruction: '',
      agents: [{ route: 'claude' }],
      inputs: []
    },
    {
      id: 'answer',
      kind: 'do',
      title: 'Opinions',
      instruction: '',
      agents: [{ route: 'claude' }, { route: 'codex' }],
      inputs: []
    },
    {
      id: 'final',
      kind: 'synthesize',
      title: 'Final',
      instruction: '',
      agents: [{ route: 'claude' }],
      inputs: ['answer']
    }
  ]
}

/** Finish now pressed while JEV was still reading the question: nothing recorded yet. */
const finishing = (id: string) => !workflowTerminalCall(SPEC, id)
const answering = (noul: number) => (call: GraphCall) =>
  call.route ? { noul } : text(`${call.stepId} answer`)

/** The program's loop once finishing: a refused agent call settles as skipped, never answered. */
function finish(answer: (call: GraphCall) => unknown) {
  const config = { ...configFor(SPEC), refused: finishing }
  const outcomes = new Map<string, GraphOutcome>()
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 20 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      const refused = !call.route && finishing(call.id)
      outcomes.set(call.id, refused ? { failed: true, skipped: true } : { value: answer(call) })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return plan
}

describe('Finish now with a one-answer route', () => {
  it('reserves both calls that can end the run, and nothing else', () => {
    expect(workflowTerminalCall(SPEC, 'direct/a0')).toBe(true)
    expect(workflowTerminalCall(SPEC, 'final/a0')).toBe(true)
    expect(workflowTerminalCall(SPEC, 'answer/a0')).toBe(false)
    const reserve = workflowFinishReserve(SPEC)!.reserve
    // Finish now sets the limit to the other calls recorded plus the reserve: here 0 + 1.
    expect(graphAdmissionClosed(SPEC, reserve, [])).toBe(true)
    expect(graphFinishState(SPEC, 4, ['direct/a0'])).toEqual({ closed: false, open: false })
  })

  it('admits the one answer after a YES, and the final step after a NO, through the store rule', () => {
    const db = new OrchestrationDb(':memory:')
    databases.push(db)
    const execution = { id: 'run', call_limit: 1 }
    const admit = (callId: string) =>
      assertGraphAttemptAdmissible(db.db, execution, SPEC, callId, true)
    expect(() => admit('direct/a0')).not.toThrow()
    expect(() => admit('final/a0')).not.toThrow()
    expect(() => admit('answer/a0')).toThrow(GRAPH_FINISHING_REFUSAL)
  })

  it('ends with the one answer when JEV says yes after Finish now', () => {
    const plan = finish(answering(0.9))
    expect(plan.outcome).toMatchObject({ state: 'completed', final: { stepId: 'direct' } })
    expect(plan.outcome?.final?.markdown).toMatch(/^direct answer\n\n/)
  })

  it('keeps the final step on the full branch when JEV says no after Finish now', () => {
    const plan = finish(answering(0.1))
    expect(plan.calls.filter((call) => call.stepId === 'direct' && !call.route)).toEqual([])
    expect(plan.runs.answer[0].calls.every((view) => view.skipped)).toBe(true)
    // The final step stays reserved: it runs on what the run has, and the run ends with it.
    expect(finishing('final/a0')).toBe(false)
    expect(plan.outcome).toMatchObject({ state: 'completed', final: { stepId: 'final' } })
  })
})
