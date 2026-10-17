import { describe, expect, it } from 'vitest'
import { DECISION_SCENARIOS } from './graph-decision-test-scenarios'
import { graphJudgingGates } from './graph-judging-gates'
import { planWorkflowGraph } from './graph-plan'
import type { GraphCall, GraphConfig, GraphOutcome } from './graph-plan-types'
import { admittedDecisionRules, configFor, task } from './graph-test-harness'

const USAGE = { inputTokens: 400, outputTokens: 8 }

/** Drives a scenario to the end; every JEV screen and ballot also carries tokens, like a live one. */
function drive(name: string, change?: (spec: GraphConfig['spec']) => Partial<GraphConfig>) {
  const scenario = DECISION_SCENARIOS.find((entry) => entry.name === name)!
  const config = { ...configFor(scenario.spec), ...change?.(scenario.spec) }
  const outcomes = new Map<string, GraphOutcome>()
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 50 && plan.ready.length; pass++) {
    for (const call of plan.ready as GraphCall[]) {
      const raw = scenario.answer(call)
      const value =
        raw && typeof raw === 'object'
          ? call.screen
            ? { ...(raw as object), usage: USAGE }
            : call.jev
              ? {
                  ...(raw as object),
                  judgment: { method: 'pairwise', usage: USAGE, durationMs: 9 }
                }
              : raw
          : raw
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return { config, gates: graphJudgingGates(config, task, plan, 'run', 7, outcomes) }
}

describe('gate lines of the judging record', () => {
  it('records the final check with its verdict, contract and JEV ballot', () => {
    const { config, gates } = drive('Council', admittedDecisionRules)
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({
      kind: 'gate',
      at: 7,
      executionId: 'run',
      template: 'council',
      stepId: 'chair',
      round: 2,
      gate: 'final-check',
      callId: 'rank/r2/jev',
      contract: config.contracts!['final-check'],
      decision: 'first-opinion',
      reason: 'judged by jev',
      jev: { status: 'done', method: 'pairwise', usage: USAGE, durationMs: 9 }
    })
  })

  it('records every set-aside screen with how many options JEV saw, scored and set aside', () => {
    const { config, gates } = drive('Discover', admittedDecisionRules)
    const screens = gates.filter((gate) => gate.gate === 'set-aside')
    expect(screens.length).toBeGreaterThan(0)
    for (const gate of screens) {
      expect(gate).toMatchObject({
        kind: 'gate',
        template: 'discover',
        stepId: 'verify',
        contract: config.contracts!['verify/set-aside'],
        decision: 'screened',
        jev: { status: 'done', usage: USAGE }
      })
      expect(gate.callId).toMatch(/^verify(\/r\d+)?\/screen$/)
      expect(gate.counts!.items).toBeGreaterThan(0)
      expect(gate.counts!.scored).toBe(gate.counts!.items - 1)
      expect(gate.counts!.setAside).toBeGreaterThanOrEqual(1)
    }
    expect(gates.some((gate) => gate.gate !== 'set-aside')).toBe(false)
  })

  it('records the shortlist, and the one-answer route with JEV’s reading', () => {
    const shortlist = drive('Decide', admittedDecisionRules).gates.find(
      (gate) => gate.gate === 'shortlist'
    )!
    expect(shortlist).toMatchObject({
      template: 'decide',
      decision: 'shortlisted',
      jev: { status: 'done', usage: USAGE }
    })
    expect(shortlist.contract).toMatch(/@\d+$/)
    expect(shortlist.counts!.items).toBeGreaterThan(0)

    const sure = drive('Decide, one answer sure', admittedDecisionRules).gates.find(
      (gate) => gate.gate === 'route'
    )!
    expect(sure).toMatchObject({
      round: 1,
      decision: 'one-answer',
      reason: 'one-answer',
      jev: { status: 'done', noul: 0.9 }
    })
    expect(sure.callId).toMatch(/\/route$/)
    expect(sure.contract).toMatch(/@\d+$/)
    const unsure = drive('Decide, one answer unsure', admittedDecisionRules).gates.find(
      (gate) => gate.gate === 'route'
    )!
    expect(unsure).toMatchObject({ decision: 'full', reason: 'unsure', jev: { noul: 0.5 } })
  })

  it('leaves the contract out for a run admitted without decision rules', () => {
    const { gates } = drive('Council')
    expect(gates[0]!.contract).toBeUndefined()
  })
})
