import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { contractByRef } from '../../../../shared/decision-contracts/decision-contract-library'
import type { ContractRef } from '../../../../shared/decision-contracts/decision-contract-types'
import { resolveDecisionContracts } from '../../../../shared/decision-contracts/decision-points'
import type { DecisionRequest, DecisionResult } from '../../../../shared/structured-decisions'
import { WORKFLOW_SCREEN_SET_ASIDE } from '../../../../shared/workflow-graph'
import {
  decideOneAnswerRoute,
  ONE_ANSWER_UNSURE_BAND
} from '../../../../shared/workflow-one-answer'
import { projectGraphRun } from '../local-workflow-graph-projection'
import { runWorkflowPreset } from '../workflow-preset-runner'
import type { WorkflowProgramContext } from '../workflow-program-context'
import { GRAPH_PROGRAM_REVISION } from '../workflow-program-revisions'
import {
  assertDecisionReplaySupported,
  DECISION_RULES,
  graphContract,
  graphDecisionAdmission,
  graphDecisionRules,
  graphRouteBand,
  graphScoreLine
} from './graph-decision-rules'
import { DECISION_SCENARIOS, planDigest } from './graph-decision-test-scenarios'
import { decideSpec } from './graph-decide-test-fixtures'
import type { GraphItem } from './graph-items'
import { createGraphJevJudge } from './graph-jev'
import { createGraphJevRouter, graphRouteDecisionRequest } from './graph-jev-route'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall, GraphConfig, GraphPlan } from './graph-plan-types'
import { runWorkflowGraphProgram } from './graph-program'
import { admittedDecisionRules, configFor, drive, SEATS, task } from './graph-test-harness'
import { graphTriage } from './graph-triage'

vi.mock('./graph-program', () => ({
  runWorkflowGraphProgram: vi.fn(async () => ({ final: { stepId: 'x', markdown: '' }, gaps: [] }))
}))

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requestOf = (call: GraphCall) => call.jev ?? call.screen ?? call.route
const jevCalls = (plan: GraphPlan) => plan.calls.filter((call) => requestOf(call))
// The same plan with every `contract` key removed: what a run without decision rules would hold.
const withoutContracts = (plan: GraphPlan) =>
  createHash('sha256')
    .update(JSON.stringify(plan, (key, value: unknown) => (key === 'contract' ? undefined : value)))
    .digest('hex')

const SCENARIOS = DECISION_SCENARIOS.map((scenario) => [scenario.name, scenario] as const)

function snapshotOf(scenario: (typeof DECISION_SCENARIOS)[number], host: object) {
  const config = configFor(scenario.spec)
  return {
    version: 1 as const,
    graphProgramRevision: GRAPH_PROGRAM_REVISION,
    graph: { spec: scenario.spec, agentSeats: config.agentSeats },
    seats: SEATS,
    task,
    access: 'frozen' as const,
    host
  }
}

const dirs: string[] = []
afterEach(() => {
  vi.mocked(runWorkflowGraphProgram).mockClear()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const storeIn = () => {
  const dir = mkdtempSync(join(tmpdir(), 'decision-rules-'))
  dirs.push(dir)
  return new GraphJevStore(join(dir, 'jev-ballots.json'))
}

describe('decision rules are frozen at admission', () => {
  it.each(SCENARIOS)('%s: admission freezes every point, and the runner reads it back', (_n, s) => {
    const admitted = graphDecisionAdmission(s.spec)
    expect(admitted).toEqual({
      decisionRules: DECISION_RULES,
      contracts: resolveDecisionContracts(s.spec)
    })
    expect(graphDecisionRules({ host: admitted })).toEqual(admitted)
    expect(() => assertDecisionReplaySupported(s.spec, { host: admitted })).not.toThrow()
  })

  it('reads nothing from an older snapshot, which plans under the legacy table', () => {
    for (const snapshot of [{}, { host: {} }, { host: { decisionRules: '1', contracts: {} } }]) {
      expect(graphDecisionRules(snapshot)).toEqual({})
    }
    const find = DECISION_SCENARIOS.find((scenario) => scenario.name === 'Find the best')!
    expect(graphContract(configFor(find.spec), 'judge/screen')).toBe('find-screen@1')
    expect(graphContract(configFor(find.spec), 'not-a-point')).toBeUndefined()
    const admitted = { ...configFor(find.spec), ...admittedDecisionRules(find.spec) }
    expect(graphContract(admitted, 'judge/screen')).toBe('find-screen@2')
    expect(() => graphContract(admitted, 'not-a-point')).toThrow(/no decision contract/)
  })

  it('hands the frozen contracts to the program, and nothing to an older run', async () => {
    const [, council] = SCENARIOS[0]!
    const context = {} as WorkflowProgramContext
    await runWorkflowPreset(context, 'council', snapshotOf(council, { improveRules: 2 }) as never)
    const legacy = vi.mocked(runWorkflowGraphProgram).mock.calls[0]![1]
    expect(legacy).not.toHaveProperty('decisionRules')
    expect(legacy).not.toHaveProperty('contracts')
    const host = graphDecisionAdmission(council.spec)
    await runWorkflowPreset(context, 'council', snapshotOf(council, host) as never)
    expect(vi.mocked(runWorkflowGraphProgram).mock.calls[1]![1]).toMatchObject(host)
  })

  it('shows a run in the view with the requests it made', () => {
    const scenario = { name: 'route', spec: decideSpec(true), answer: () => undefined }
    const route = (host: object) =>
      projectGraphRun(snapshotOf(scenario, host) as never, new Map(), false).plan.calls.find(
        (call) => call.route
      )!.route
    expect(route({})).toEqual({ question: task.prompt })
    expect(route(graphDecisionAdmission(scenario.spec))).toEqual({
      question: task.prompt,
      contract: 'decide-one-answer@1'
    })
  })
})

describe('a replay refuses what this build cannot judge by', () => {
  const [, council] = SCENARIOS[0]!
  const host = graphDecisionAdmission(council.spec)
  const refused = (change: object) =>
    expect(() => assertDecisionReplaySupported(council.spec, { host: { ...host, ...change } }))

  it('refuses an unknown ref, before the program starts', () => {
    const contracts = { ...host.contracts, 'rank/ballot': 'council-peer-rank@9' }
    refused({ contracts }).toThrow(
      'This run judges rank/ballot by council-peer-rank@9, which this build does not know; start it again.'
    )
    expect(() =>
      runWorkflowPreset(
        {} as WorkflowProgramContext,
        'council',
        snapshotOf(council, { ...host, contracts }) as never
      )
    ).toThrow(/council-peer-rank@9/)
    expect(runWorkflowGraphProgram).not.toHaveBeenCalled()
  })

  it('refuses a contract of the wrong kind, a missing point, newer rules and no table', () => {
    refused({ contracts: { ...host.contracts, 'rank/ballot': 'find-screen@2' } }).toThrow(
      /can't replay how this run judges rank\/ballot/
    )
    const { 'final-check': _gone, ...partial } = host.contracts
    refused({ contracts: partial }).toThrow(/judges final-check/)
    refused({ decisionRules: DECISION_RULES + 1 }).toThrow(/another version of OmniConsole/)
    refused({ contracts: undefined }).toThrow(/no decision contracts saved/)
    expect(() => assertDecisionReplaySupported(council.spec, { host: {} })).not.toThrow()
  })
})

// Which contract each JEV call of the scenarios is judged by, by call id.
const EXPECTED: [RegExp, ContractRef][] = [
  [/^rank\/jev$/, 'council-peer-rank@1'],
  [/^rank\/r2\/jev$/, 'council-final-check@1'],
  [/^verify\/r\d+\/screen$/, 'discover-set-aside@1'],
  [/^develop\/screen$/, 'decide-shortlist@1'],
  [/^compare\/r2\/jev$/, 'decide-final-check@1'],
  [/^compare\/r\d+\/jev$/, 'decide-compare-line@1'],
  [/^direct\/route$/, 'decide-one-answer@1'],
  [/^judge\/screen(?:\/page\.\d+)?$/, 'find-screen@2'],
  [/^judge\/jev$/, 'find-final@1'],
  [/^judge\/r\d+\/jev$/, 'improve-judge@1']
]

describe("a new run's JEV requests carry the frozen refs", () => {
  it.each(SCENARIOS)('%s', (_name, scenario) => {
    const rules = admittedDecisionRules(scenario.spec)
    const calls = jevCalls(drive(scenario.spec, scenario.answer, rules))
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      const expected = EXPECTED.find(([pattern]) => pattern.test(call.id))?.[1]
      expect({ id: call.id, contract: requestOf(call)!.contract }).toEqual({
        id: call.id,
        contract: expected
      })
      expect(Object.values(rules.contracts!)).toContain(expected)
    }
    // An older run's requests carry no key at all, so their digests are the ones it recorded.
    for (const call of jevCalls(drive(scenario.spec, scenario.answer))) {
      expect(requestOf(call)).not.toHaveProperty('contract')
    }
  })

  it('meets every kind of decision', () => {
    const kinds = new Set(
      DECISION_SCENARIOS.flatMap((scenario) =>
        jevCalls(drive(scenario.spec, scenario.answer, admittedDecisionRules(scenario.spec))).map(
          (call) => contractByRef(requestOf(call)!.contract!).kind
        )
      )
    )
    expect(kinds.size).toBe(7)
  })

  it('never reuses a ballot recorded without its contract', async () => {
    const [, council] = SCENARIOS[0]!
    const call = drive(
      council.spec,
      council.answer,
      admittedDecisionRules(council.spec)
    ).calls.find((entry) => entry.id === 'rank/jev')!
    const { contract, ...legacy } = call.jev!
    expect(contract).toBe('council-peer-rank@1')
    const store = storeIn()
    store.write(call.id, { digest: sha(legacy), outcome: { value: { markdown: 'old' } }, at: 0 })
    const judge = createGraphJevJudge({ store, cacheOnly: true })
    await expect(judge({ ...call, jev: legacy })).resolves.toEqual({ value: { markdown: 'old' } })
    await expect(judge(call)).rejects.toThrow('JEV ballot is not recorded: rank/jev')
  })
})

describe('a v1 policy decides exactly as the constants', () => {
  it.each(SCENARIOS)('%s: the same plan as a run without decision rules', (_name, scenario) => {
    const rules = admittedDecisionRules(scenario.spec)
    // Find's screen is pinned at @1 here: @2 changes, by design, what an unscored option means.
    const v1 = {
      ...rules,
      contracts: Object.fromEntries(
        Object.entries(rules.contracts!).map(([key, ref]) => [
          key,
          ref === 'find-screen@2' ? 'find-screen@1' : ref
        ])
      )
    } satisfies Partial<GraphConfig>
    const frozen = drive(scenario.spec, scenario.answer, v1)
    expect(withoutContracts(frozen)).toBe(planDigest(drive(scenario.spec, scenario.answer)))
    expect(frozen.calls.some((call) => requestOf(call)?.contract)).toBe(true)
  })

  it('reads the same score line and route band as the constants', () => {
    const lines: [string, string][] = [
      ['Discover', 'verify/set-aside'],
      ['Decide', 'develop/shortlist']
    ]
    for (const [name, key] of lines) {
      const { spec } = DECISION_SCENARIOS.find((scenario) => scenario.name === name)!
      for (const rules of [{}, admittedDecisionRules(spec)]) {
        expect(graphScoreLine({ spec, ...rules }, key)).toBe(WORKFLOW_SCREEN_SET_ASIDE)
      }
    }
    const routed = decideSpec(true)
    for (const rules of [{}, admittedDecisionRules(routed)]) {
      expect(graphRouteBand({ spec: routed, ...rules })).toEqual(ONE_ANSWER_UNSURE_BAND)
    }
  })

  it('sets aside and routes the same on and around every line', () => {
    const item = (index: number): GraphItem => ({
      key: `i${index}`,
      title: `Item ${index}`,
      detail: 'd',
      location: 'src/a.ts:1',
      severity: 'high',
      round: 1,
      sourceCallId: 'find/a0',
      repeats: 0
    })
    const items = Array.from({ length: 7 }, (_, index) => item(index))
    const scores = { i0: 0, i1: 0.99, i2: 1, i3: 1.01, i4: 2, i6: 4 }
    const outcome = { value: { scores, criteria: [], unscored: ['i5'] } }
    const { spec } = DECISION_SCENARIOS.find((scenario) => scenario.name === 'Discover')!
    const below = graphScoreLine({ spec, ...admittedDecisionRules(spec) }, 'verify/set-aside')
    const today = graphTriage('Verify', items, outcome)
    expect(graphTriage('Verify', items, outcome, below)).toEqual(today)
    expect(today.setAside.map((entry) => entry.key)).toEqual(['i0', 'i1'])
    // The line is read, not ignored: a higher one sets more aside.
    expect(graphTriage('Verify', items, outcome, 2).setAside).toHaveLength(4)
    const routed = decideSpec(true)
    const band = graphRouteBand({ spec: routed, ...admittedDecisionRules(routed) })
    for (const noul of [
      0,
      0.2,
      0.35,
      0.350001,
      0.5,
      0.649999,
      0.65,
      0.650001,
      0.9,
      1,
      Number.NaN
    ]) {
      expect(decideOneAnswerRoute({ noul }, band)).toEqual(decideOneAnswerRoute({ noul }))
    }
    expect(decideOneAnswerRoute({ failed: 'x' }, band)).toEqual(
      decideOneAnswerRoute({ failed: 'x' })
    )
    expect(decideOneAnswerRoute({ noul: 0.8 }).route).toBe('one-answer')
    expect(decideOneAnswerRoute({ noul: 0.8 }, [0.1, 0.9]).route).toBe('full')
  })

  it('asks JEV the same questions and gets the same ballot, under a new digest', async ({
    onTestFinished
  }) => {
    // Compare policy behavior without comparing two wall-clock execution durations.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_790_269_200_000)
    onTestFinished(() => clock.mockRestore())
    const [, council] = SCENARIOS[0]!
    const call = drive(
      council.spec,
      council.answer,
      admittedDecisionRules(council.spec)
    ).calls.find((entry) => entry.id === 'rank/jev')!
    const { contract: _contract, ...legacy } = call.jev!
    const answer = async (decision: DecisionRequest): Promise<DecisionResult> => {
      const state = decision.state as { response_1: string; response_2: string }
      const firstWins = state.response_1 < state.response_2 ? 0.7 : 0.3
      return {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        answers: {
          better: {
            type: 'choice',
            choice: firstWins >= 0.5 ? 'response_1' : 'response_2',
            probabilities: { response_1: firstWins, response_2: 1 - firstWins },
            confidence: 1
          }
        },
        usage: { inputTokens: 1, outputTokens: 0 }
      }
    }
    const ask = async (request: GraphCall['jev']) => {
      const sent: DecisionRequest[] = []
      const store = storeIn()
      const outcome = await createGraphJevJudge({
        store,
        evaluate: async (decision) => {
          sent.push(decision)
          return answer(decision)
        },
        credential: async () => 'k'.repeat(24),
        environment: {}
      })({ ...call, jev: request })
      const digest = store.read(call.id)!.digest
      return { sent: sent.map((decision) => JSON.stringify(decision)).sort(), outcome, digest }
    }
    const today = await ask(legacy)
    const frozen = await ask(call.jev)
    expect(frozen.sent).toEqual(today.sent)
    expect(frozen.outcome).toEqual(today.outcome)
    expect((frozen.outcome as { value: { unsure?: true } }).value.unsure).toBe(true)
    expect(frozen.digest).not.toBe(today.digest)
    // The ballot is judged by the contract it names: one that does not rank is refused.
    await expect(ask({ ...call.jev!, contract: 'find-screen@2' })).rejects.toThrow(
      'find-screen@2 judges by scores, which this build does not run here.'
    )
  })

  it('reads the route with the same question and band', async () => {
    const routed = decideSpec(true)
    const call = drive(routed, () => undefined, admittedDecisionRules(routed)).calls.find(
      (entry) => entry.route
    )!
    const { contract, ...legacy } = call.route!
    expect(contract).toBe('decide-one-answer@1')
    expect(graphRouteDecisionRequest(call.route!)).toEqual(graphRouteDecisionRequest(legacy))
    for (const noul of [0.3, 0.35, 0.5, 0.65, 0.9]) {
      const read = (route: GraphCall['route']) =>
        createGraphJevRouter({
          store: storeIn(),
          decide: async () => ({ answers: { yes: { type: 'noul', noul } } }) as never
        })({ ...call, route })
      expect(await read(call.route)).toEqual(await read(legacy))
    }
    expect(() => graphRouteDecisionRequest({ ...legacy, contract: 'council-peer-rank@1' })).toThrow(
      'council-peer-rank@1 judges by auto'
    )
  })
})
