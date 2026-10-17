import { describe, expect, it } from 'vitest'
import { projectGraphRun } from './local-workflow-graph-projection'
import { GRAPH_PROGRAM_REVISION } from './workflow-program-revisions'
import { graphDecisionAdmission } from './graph/graph-decision-rules'
import { DECISION_SCENARIOS } from './graph/graph-decision-test-scenarios'
import { configFor, SEATS, task } from './graph/graph-test-harness'
import type { WorkflowSpec } from '../../../shared/workflow-graph'

const find = DECISION_SCENARIOS.find((scenario) => scenario.name === 'Find the best')!.spec

function contractsOf(spec: WorkflowSpec, host: object) {
  const snapshot = {
    version: 1 as const,
    graphProgramRevision: GRAPH_PROGRAM_REVISION,
    graph: { spec, agentSeats: configFor(spec).agentSeats },
    seats: SEATS,
    task,
    access: 'frozen' as const,
    host
  }
  return projectGraphRun(snapshot as never, new Map(), false).graphRun.contracts
}

describe('projectGraphRun contracts', () => {
  it('shows each frozen contract of a new run with how far it has been checked', () => {
    const contracts = contractsOf(find, graphDecisionAdmission(find))
    expect(contracts).toEqual([
      {
        point: 'judge/screen',
        ref: 'find-screen@2',
        state: 'not-yet',
        fallback: 'keep-and-verify'
      },
      { point: 'judge/ballot', ref: 'find-final@1', state: 'not-yet', fallback: 'models-decide' }
    ])
  })

  it('shows the legacy @1 status for a run saved before decision rules', () => {
    expect(contractsOf(find, {})?.map((check) => check.ref)).toEqual([
      'find-screen@1',
      'find-final@1'
    ])
  })

  it('leaves out a frozen contract this build does not know', () => {
    const host = { decisionRules: 1, contracts: { 'judge/screen': 'find-screen@9' } }
    expect(contractsOf(find, host)).toEqual([])
  })
})
