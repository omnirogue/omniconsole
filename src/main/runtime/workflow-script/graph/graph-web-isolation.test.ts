import { describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { decideWorkflow } from '../../../../shared/workflow-graph-decide'
import { screenedDiscover } from '../../../../shared/workflow-discover-screen.test-fixture'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { workflowWebSources } from '../../../../shared/workflow-graph-web'
import { DECIDE_SKEPTIC_ROUND } from '../../../../shared/workflow-decide-guard'
import { decideAnswer } from './graph-decide-test-fixtures'
import type { GraphCall } from './graph-plan-types'
import { drive } from './graph-test-harness'
import {
  anyGraphAnswer,
  webAnswer,
  webResearch,
  type WebPageFixture
} from './graph-web-test-fixtures'
import { WEB_RULES } from './graph-web-types'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']
const URL = 'https://a.example/canary'
const CANARY = 'The zebra files its taxes on the moon every leap year.'
const PAGES: Record<string, WebPageFixture> = {
  [URL]: { text: `These are public words. ${CANARY}`, title: `Title: ${CANARY}` }
}

const reading = (spec: WorkflowSpec, id: string, extra: object = {}): WorkflowSpec =>
  normalizeWorkflowSpec(
    {
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === id ? { ...step, web: { urls: [URL] }, ...extra } : step
      )
    },
    ROUTES
  )

const improve = () => {
  const spec = workflowTemplate('improve', ROUTES)
  return normalizeWorkflowSpec(
    {
      ...spec,
      steps: [
        { id: 'sources', kind: 'do', title: 'Sources', agents: [{}], web: { urls: [URL] } },
        ...spec.steps.map((step) =>
          step.id === 'improve' ? { ...step, inputs: ['sources'] } : step
        )
      ]
    },
    ROUTES
  )
}

const decide = () => reading(normalizeWorkflowSpec(decideWorkflow(ROUTES), ROUTES), 'options')

// A run that reads pages scores only by a rubric the person wrote (workflow-graph-validate-web.ts).
const writtenRubrics = (spec: WorkflowSpec): WorkflowSpec => ({
  ...spec,
  steps: spec.steps.map((step) =>
    step.forEach?.screen?.rubricFrom
      ? { ...step, forEach: { ...step.forEach, screen: { rubric: 'Is it a real defect?' } } }
      : step
  )
})

type Case = {
  name: string
  spec: () => WorkflowSpec
  answer?: (spec: WorkflowSpec) => (call: GraphCall) => unknown
  /** Judges this run must actually reach, so the absence of the canary means something. */
  judges: ((call: GraphCall) => boolean)[]
  /** Refused outright: validation and the planner both turn it away, so no judge runs. */
  refused?: string
}

const kindOf = (spec: WorkflowSpec, call: GraphCall) =>
  spec.steps.find((step) => step.id === call.stepId)!.kind

const CASES: Case[] = [
  {
    name: 'a research panel: reviews and the synthesis',
    spec: () => webResearch([URL]),
    judges: [(call) => call.stepId === 'critics', (call) => call.stepId === 'final']
  },
  {
    name: 'Council: JEV and the peer rankings, the chair and its final check',
    spec: () => reading(workflowTemplate('council', ROUTES), 'answer'),
    // An unsure JEV brings in the model rankers too, so both kinds of judge are checked.
    answer: (spec) => (call) => {
      const value = anyGraphAnswer(spec, PAGES)(call)
      return call.jev && call.round === 1 ? { ...(value as object), unsure: true } : value
    },
    judges: [
      (call) => call.stepId === 'rank' && !!call.jev && call.round === 1,
      (call) => call.stepId === 'rank' && !call.jev && call.round === 1,
      (call) => call.stepId === 'chair',
      (call) => call.stepId === 'rank' && call.round === 2
    ]
  },
  {
    name: "Decide: refused, since its shortlist, comparison and skeptic score by the frame's answer",
    spec: decide,
    refused: "from Frame's answer",
    answer: (spec) => {
      const rest = decideAnswer()
      return (call) =>
        call.web ? webAnswer(call, PAGES) : (rest(call) ?? anyGraphAnswer(spec, PAGES)(call))
    },
    judges: [
      (call) => !!call.screen,
      (call) => call.stepId === 'compare' && !!call.jev && call.round > 2,
      (call) => call.stepId === 'compare' && call.round === 2,
      (call) => call.stepId === 'compare' && call.round >= DECIDE_SKEPTIC_ROUND,
      (call) => call.stepId === 'memo'
    ]
  },
  {
    name: 'Improve: the improvers and every judge round',
    spec: improve,
    judges: [
      (call) => call.stepId === 'improve',
      (call) => call.stepId === 'judge' && !!call.jev,
      (call) => call.stepId === 'judge' && call.round > 1
    ]
  },
  {
    name: 'Discover: the verifiers and the report, with no rubric to write',
    spec: () => reading(workflowTemplate('discover', ROUTES), 'find'),
    judges: [
      (call) => call.stepId === 'verify' && !call.evidence,
      (call) => call.stepId === 'report'
    ]
  },
  {
    name: 'Discover with a screen: the JEV screen, the verifiers and the report',
    spec: () => reading(writtenRubrics(screenedDiscover(ROUTES)), 'find'),
    judges: [
      (call) => !!call.screen,
      (call) => call.stepId === 'verify' && !call.screen && !call.evidence,
      (call) => call.stepId === 'report'
    ]
  }
]

describe('page text reaches only the agents of the step that reads it', () => {
  it.each(CASES)('$name', ({ spec: make, answer, judges, refused }) => {
    const spec = make()
    const problems = validateWorkflowSpec(spec, { available: ROUTES }).problems
    if (refused) {
      expect(problems.map((problem) => problem.message).join(' ')).toContain(refused)
      expect(() => drive(spec, anyGraphAnswer(spec, PAGES), { webRules: WEB_RULES })).toThrow(
        "This run's web pages break the rules"
      )
      return
    }
    expect(problems).toEqual([])
    const readers = new Set(workflowWebSources(spec).flatMap((source) => source.readers))
    const plan = drive(spec, (answer ?? ((s) => anyGraphAnswer(s, PAGES)))(spec), {
      webRules: WEB_RULES
    })
    const agentReaders = plan.calls.filter(
      (call) => readers.has(call.stepId) && !call.web && !call.jev && !call.screen
    )
    expect(agentReaders.length).toBeGreaterThan(0)
    for (const call of agentReaders) {
      expect(call.prompt, call.id).toContain(CANARY)
    }
    for (const call of plan.calls.filter((entry) => !agentReaders.includes(entry))) {
      const seen = JSON.stringify({
        prompt: call.prompt,
        jev: call.jev,
        screen: call.screen,
        route: call.route,
        evidence: call.evidence,
        web: call.web
      })
      expect(seen, call.id).not.toContain('zebra')
      expect(seen, call.id).not.toContain('public words. The')
    }
    for (const judge of judges) {
      expect(plan.calls.some(judge), judge.toString()).toBe(true)
    }
    expect(plan.calls.filter((call) => kindOf(spec, call) !== 'do').length).toBeGreaterThan(0)
    expect(plan.calls.length).toBeLessThanOrEqual(planWorkflowCalls(spec).total)
    expect(JSON.stringify(plan.outcome)).not.toContain('zebra')
  })
})
