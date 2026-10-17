import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JEV_DEFAULT_RUBRIC } from '../../../../shared/jev-rubric'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { DECISION_SCENARIOS } from './graph-decision-test-scenarios'
import { graphJudgingGates } from './graph-judging-gates'
import {
  graphJudgingDigest,
  graphJudgingEntries,
  recordGraphJudging,
  type GraphJudgingLine
} from './graph-judging-record'
import { planWorkflowGraph } from './graph-plan'
import type { GraphCall, GraphConfig, GraphOutcome } from './graph-plan-types'
import { admittedDecisionRules, configFor, task } from './graph-test-harness'

const ROUTES = ['claude', 'codex', 'grok'] as const

/** Every JEV ballot the scenario answers also carries the judgment a live ballot keeps. */
const JUDGMENT = {
  method: 'pairwise',
  model: 'jev-test',
  order: [],
  scores: {},
  usage: { inputTokens: 1_000, outputTokens: 20 },
  unsureReason: 'the top two are close',
  calls: 2,
  durationMs: 250
}

function drive(
  spec: GraphConfig['spec'],
  answer: (call: GraphCall) => unknown,
  change: Partial<GraphConfig> = {}
) {
  const config = { ...configFor(spec), ...change }
  const outcomes = new Map<string, GraphOutcome>()
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 50 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      const raw = answer(call)
      const value =
        raw && typeof raw === 'object' && call.jev
          ? { ...(raw as object), judgment: JUDGMENT }
          : raw
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return { config, plan, outcomes }
}

const scenario = (name: string) => DECISION_SCENARIOS.find((entry) => entry.name === name)!

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

describe('the judging record', () => {
  it('names the contract and the rubric JEV saw, and keeps its method, tokens, reason and time', () => {
    const improve = scenario('Improve')
    const { config, plan, outcomes } = drive(
      improve.spec,
      improve.answer,
      admittedDecisionRules(improve.spec)
    )
    const entries = graphJudgingEntries(config, task, plan, 'run-1', 5, outcomes)
    expect(entries.length).toBeGreaterThanOrEqual(3)
    const judged = entries.filter((entry) => entry.jev)
    expect(judged.length).toBeGreaterThanOrEqual(2)
    for (const entry of judged) {
      expect(entry.kind).toBe('rank')
      expect(entry.contract).toBe(config.contracts!['judge/ballot'])
      const request = plan.calls.find(
        (call) => call.jev && call.stepId === entry.stepId && call.round === entry.round
      )!.jev!
      expect(entry.jevRubricDigest).toBe(
        graphJudgingDigest(request.instruction.trim() || JEV_DEFAULT_RUBRIC)
      )
      expect(entry.jev).toMatchObject({
        method: 'pairwise',
        usage: { inputTokens: 1_000, outputTokens: 20 },
        unsureReason: 'the top two are close',
        durationMs: 250
      })
    }
    // Round 3: JEV unsure; Improve lets no model compare, so it still decided alone.
    const unsure = entries.find((entry) => entry.round === 3)!
    expect(unsure.jev).toMatchObject({ unsure: true, counted: true })
    expect(unsure.models).toEqual([])
    // The best version defends its place as the incumbent, never as its seat's new answer.
    expect(entries.some((entry) => entry.candidates.some((candidate) => candidate.incumbent))).toBe(
      true
    )
  })

  it('tells an unsure JEV that escalated from a JEV that gave no ballot', () => {
    const council = scenario('Council')
    const escalated = drive(council.spec, council.answer, admittedDecisionRules(council.spec))
    const [round] = graphJudgingEntries(
      escalated.config,
      task,
      escalated.plan,
      'run-5',
      5,
      escalated.outcomes
    )
    expect(round!.jev).toMatchObject({ unsure: true, unsureReason: 'the top two are close' })
    expect(round!.models.length).toBeGreaterThan(0)
    expect(round!.jevFailed).toBeUndefined()
    const failed = drive(
      council.spec,
      (call) => (call.jev ? undefined : council.answer(call)),
      admittedDecisionRules(council.spec)
    )
    const [alone] = graphJudgingEntries(
      failed.config,
      task,
      failed.plan,
      'run-6',
      5,
      failed.outcomes
    )
    expect(alone!.jev).toBeUndefined()
    expect(alone!.jevFailed).toBe(true)
    expect(alone!.contract).toBe(failed.config.contracts!['rank/ballot'])
    expect(alone!.models.length).toBeGreaterThan(0)
  })

  it('leaves the new fields out where the run has nothing to say, so older readers still read it', () => {
    const council = scenario('Council')
    const { config, plan, outcomes } = drive(council.spec, council.answer)
    const [first] = graphJudgingEntries(config, task, plan, 'run-2', 5, outcomes)
    expect(first).toBeDefined()
    expect(first!.contract).toBeUndefined()
    expect(first!.jevRubricDigest).toEqual(expect.any(String))
    // Without outcomes (the old call shape) the ballot still records what the plan shows.
    const bare = graphJudgingEntries(config, task, plan, 'run-2', 5)
    expect(bare[0]!.jev).toEqual({
      ranking: expect.any(Array),
      unsure: expect.any(Boolean),
      counted: expect.any(Boolean)
    })
  })

  it('writes the run its own copy with the gates, and appends to the shared record only once', () => {
    dir = mkdtempSync(join(tmpdir(), 'judging-record-'))
    const council = scenario('Council')
    const { config, plan, outcomes } = drive(
      council.spec,
      council.answer,
      admittedDecisionRules(council.spec)
    )
    const lines = [
      ...graphJudgingEntries(config, task, plan, 'run-3', 5, outcomes),
      ...graphJudgingGates(config, task, plan, 'run-3', 5, outcomes)
    ]
    recordGraphJudging(lines, 'run-3', dir)
    recordGraphJudging(lines.slice(0, 1), 'run-3', dir)
    const own = JSON.parse(readFileSync(join(dir, 'run-3', 'judging.json'), 'utf8')) as unknown[]
    expect(own).toHaveLength(1)
    const shared = readFileSync(join(dir, 'workflow-judging.jsonl'), 'utf8')
    expect(shared.endsWith('\n')).toBe(true)
    const parsed = shared
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as GraphJudgingLine)
    expect(parsed).toEqual(lines)
    expect(parsed.filter((line) => line.kind === 'gate')).toHaveLength(1)
  })

  it('records nothing for a template without a judged round', () => {
    const spec = workflowTemplate('council', ROUTES)
    const { config, plan, outcomes } = drive(spec, () => undefined)
    expect(graphJudgingEntries(config, task, plan, 'run-4', 5, outcomes)).toEqual([])
    dir = mkdtempSync(join(tmpdir(), 'judging-record-'))
    recordGraphJudging([], 'run-4', dir)
    expect(() => readFileSync(join(dir, 'workflow-judging.jsonl'))).toThrow()
  })
})
