import { describe, expect, it } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { workflowRunResult } from '../../../../shared/workflow-run-result'
import { projectGraphRun } from '../local-workflow-graph-projection'
import type { GraphEvidenceCheck } from './graph-evidence-check'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import { FIND_RULES, type GraphConfig } from './graph-plan-types'
import { EVIDENCE_RULES, graphEvidenceAdmission, type GraphPreVerify } from './graph-pre-verify'
import { configFor, SEATS, task, text } from './graph-test-harness'

const discover = () => workflowTemplate('discover', ['claude', 'codex', 'grok'])
const RULES = { evidenceRules: EVIDENCE_RULES }
const BRIEF = '## Scope\nSCOPE: OK\n\n## Rubric\n- Is it real?\n- Does it matter?'

const STALE = {
  title: 'Stale entries served',
  detail: 'refresh() is never called: `rg -n "refresh\\(" src` finds only its definition.',
  location: 'src/cache.ts:10',
  severity: 'high',
  excerpt: 'if (entry.expires > now) {',
  trigger: 'reading an entry after it expired'
}
const GHOST = {
  title: 'Ghost retry loop',
  detail: 'The loop does not end when the limit is reached.',
  location: 'src/ghost.ts:5',
  severity: 'critical',
  excerpt: 'while (retries < limit) {',
  trigger: 'a request that always fails'
}
const LEAK = {
  title: 'Listener leak',
  detail: 'A listener is added on every render.',
  location: 'src/leak.ts:7',
  severity: 'medium',
  excerpt: 'window.addEventListener("resize", onResize)',
  trigger: 'rendering the panel twice'
}

const gone = (file: string | undefined) => !!file?.includes('ghost')

function checksFor(call: GraphCall): Record<string, GraphEvidenceCheck> {
  return Object.fromEntries(
    call.evidence!.items.map((item): [string, GraphEvidenceCheck] => [
      item.key,
      gone(item.file)
        ? { status: 'unreadable', line: item.line }
        : { status: 'found', line: item.line, context: `${item.line} | ${item.excerpt}` }
    ])
  )
}

/** The app's pre-verify as the checker records it: a ghost file is absent, every search hits. */
function preVerifyFor(call: GraphCall): Record<string, GraphPreVerify> {
  return Object.fromEntries(
    call.evidence!.preVerify!.map((fact): [string, GraphPreVerify] => {
      const missing = gone(fact.citations[0]?.file)
      const searches = fact.searches.map((search) => ({ search, hits: ['src/refresh.ts:3'] }))
      return [
        fact.key,
        {
          citations: fact.citations.map((citation) =>
            missing
              ? { ...citation, status: 'absent' as const }
              : { ...citation, status: 'ok' as const, lines: 80 }
          ),
          ...(fact.absence ? { absence: fact.absence } : {}),
          searches,
          flags: [
            ...(missing ? [`\`${fact.citations[0]!.file}\` is not a file in the workspace.`] : []),
            ...searches.map(
              (entry) =>
                `It says "${fact.absence}", but its search \`${entry.search}\` matches at src/refresh.ts:3.`
            )
          ],
          ...(missing ? { dropped: 'None of the files it cites exists in the workspace.' } : {})
        }
      ]
    })
  )
}

/** `p`: JEV verify's probability by title, 0.99 for any other. */
type Shape = { first?: object[]; second?: object[]; unsure?: string; p?: Record<string, number> }

function answer(shape: Shape = {}) {
  return (call: GraphCall): unknown => {
    if (call.evidence) {
      return {
        checks: checksFor(call),
        ...(call.evidence.preVerify ? { preVerify: preVerifyFor(call) } : {})
      }
    }
    if (call.verify) {
      const probabilities = Object.fromEntries(
        call.verify.items.map((item) => [item.key, shape.p?.[item.title] ?? 0.99])
      )
      return { markdown: 'verified', probabilities, model: 'jev-1.13.0', durationMs: 600 }
    }
    if (call.screen) {
      return { scores: Object.fromEntries(call.screen.candidates.map((entry) => [entry.id, 3])) }
    }
    if (call.id.endsWith('/impact')) {
      const keys = [...call.prompt.matchAll(/^\[([^\]]+)\]/gm)].map((match) => match[1]!)
      return { items: keys.map((key) => ({ key, impact: 3, why: 'why', sameAs: '' })) }
    }
    if (call.stepId === 'brief') {
      return text(BRIEF)
    }
    if (call.stepId === 'scout') {
      return {
        items: [{ title: 'Cache', detail: 'The cache layer.', location: 'src', severity: 'none' }]
      }
    }
    if (call.stepId === 'find') {
      const items = call.agentIndex === 0 ? shape.first : call.agentIndex === 1 ? shape.second : []
      return { items: call.round === 1 ? (items ?? []) : [] }
    }
    if (call.stepId === 'verify') {
      const unsure = shape.unsure && call.prompt.includes(shape.unsure)
      return text(unsure ? 'Maybe.\nVERDICT: UNSURE' : 'Real.\nVERDICT: PASS')
    }
    return text('The report.')
  }
}

function run(shape: Shape, change: Partial<GraphConfig> = RULES, spec: WorkflowSpec = discover()) {
  const config = { ...configFor(spec), access: 'workspace-read' as const, ...change }
  const outcomes = new Map<string, GraphOutcome>()
  const reply = answer({ first: [STALE, GHOST, LEAK], ...shape })
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 50 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      const value = reply(call)
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return { plan, outcomes, config }
}

type Plan = ReturnType<typeof run>['plan']
const reviewed = (plan: Plan, title: string) =>
  plan.calls.some(
    (call) => /\/a\d+$/.test(call.id) && call.stepId === 'verify' && call.prompt.includes(title)
  )
const reviewerPrompt = (plan: Plan, title: string) =>
  plan.calls.find(
    (call) => /\/a\d+$/.test(call.id) && call.stepId === 'verify' && call.prompt.includes(title)
  )!.prompt
const target = (plan: Plan, title: string) =>
  plan.runs.verify![0]!.targets!.find((entry) => entry.item.title === title)!
const evidenceCall = (plan: Plan) => plan.calls.find((call) => call.evidence)!

describe('the pre-verify in a run admitted under evidence rules 2', () => {
  it('is asked for only under the rules; a legacy request is unchanged', () => {
    const { plan } = run({})
    expect(evidenceCall(plan).evidence!.preVerify!.map((fact) => fact.citations[0]?.file)).toEqual([
      'src/ghost.ts',
      'src/cache.ts',
      'src/leak.ts'
    ])
    expect(evidenceCall(plan).evidence!.preVerify![1]).toMatchObject({
      absence: 'never called',
      searches: ['rg -n "refresh\\(" src'],
      probe: 'if (entry.expires > now) {'
    })
    const legacy = run({}, {}).plan
    expect(evidenceCall(legacy).evidence).not.toHaveProperty('preVerify')
    expect(reviewed(legacy, 'Ghost retry loop')).toBe(true)
    expect(reviewerPrompt(legacy, 'Stale entries served')).not.toContain('App check of its')
  })

  it('asks each finder for the search behind an absence only under the rules', () => {
    const finder = (plan: Plan) => plan.calls.find((call) => call.stepId === 'find')!.prompt
    const instruction = 'must give in its detail the search that found nothing'
    expect(finder(run({}).plan)).toContain(instruction)
    expect(finder(run({}, {}).plan)).not.toContain(instruction)
  })

  it('never asks a Knowledge-only Discover finder for searches it cannot run', () => {
    const finder = (plan: Plan) => plan.calls.find((call) => call.stepId === 'find')!.prompt
    const frozen = run({}, { access: 'frozen', ...graphEvidenceAdmission(discover(), false) }).plan
    expect(finder(frozen)).not.toContain('must give in its detail the search that found nothing')
    expect(finder(frozen)).toBe(finder(run({}, { access: 'frozen' }).plan))
    expect(evidenceCall(frozen).evidence).not.toHaveProperty('preVerify')
  })

  it('leaves a list no review checks, as in Quick Discover, unchanged even under the rules', () => {
    const quick = workflowTemplate('quick-discover', ['claude'])
    const finder = (plan: Plan) => plan.calls.find((call) => call.stepId === 'find')!.prompt
    const { plan } = run({}, RULES, quick)
    expect(finder(plan)).not.toContain('must give in its detail the search that found nothing')
    expect(finder(plan)).toBe(finder(run({}, {}, quick).plan))
    expect(plan.calls.some((call) => call.evidence)).toBe(false)
  })

  it('sends a result no citation of which resolves to no reviewer, and says why', () => {
    const { plan } = run({})
    expect(reviewed(plan, 'Ghost retry loop')).toBe(false)
    expect(reviewed(plan, 'Listener leak')).toBe(true)
    const ghost = target(plan, 'Ghost retry loop')
    expect(ghost).toMatchObject({
      unchecked: true,
      tally: 'unverified',
      item: { evidence: { status: 'unreadable', preVerify: { dropped: expect.any(String) } } }
    })
    expect(ghost.screened).toBeUndefined()
    const verify = plan.runs.verify![0]!
    expect(verify.setAside ?? 0).toBe(0)
    expect(verify.notes).toContain(
      `Verify round 1: 1 result was dropped before review, as no file it cites exists in the workspace: ${ghost.item.key}.`
    )
    expect(verify.notes).toContain(
      "Verify round 1: the app's check of citations and absence searches flagged 1 result for the reviewers."
    )
    const report = plan.calls.find((call) => call.stepId === 'report')!.prompt
    expect(report).toContain('Not checked, dropped before review: no file it cites exists')
    expect(report).toContain('dropped before review: no file it cites exists')
    expect(report).toContain('app check flagged 1 problem')
  })

  it("puts the app's flags and checked lines in front of each reviewer", () => {
    const { plan } = run({})
    const stale = reviewerPrompt(plan, 'Stale entries served')
    expect(stale).toContain(
      'App check of its citations and absence searches, before any reviewer: 1 problem flagged. Weigh each, but judge the result on the real code.'
    )
    expect(stale).toContain(
      'Flagged: It says "never called", but its search `rg -n "refresh\\(" src` matches at src/refresh.ts:3.'
    )
    expect(stale).toContain('- `src/cache.ts:10`: exists, lines in range (80 lines).')
    expect(stale).toContain(
      '- Search `rg -n "refresh\\(" src` re-run: matches at src/refresh.ts:3.'
    )
    expect(reviewerPrompt(plan, 'Listener leak')).toContain(
      'App check of its citations and absence searches, before any reviewer: nothing flagged.'
    )
  })

  it('still reviews a result reported more than once, flagged instead of dropped', () => {
    const { plan } = run({ second: [GHOST] })
    expect(reviewed(plan, 'Ghost retry loop')).toBe(true)
    const pre = target(plan, 'Ghost retry loop').item.evidence!.preVerify!
    expect(pre.dropped).toBeUndefined()
    expect(pre.flags).toContain(
      'No file it cites exists, but it was reported more than once, so it is still reviewed.'
    )
  })

  it('leaves the review empty, with the reason, when every result is dropped', () => {
    const { plan } = run({ first: [GHOST] })
    const verify = plan.runs.verify![0]!
    expect(verify.state).toBe('empty')
    expect(verify.reason).toBe(
      'Nothing to check: no file cited by its one result exists in the workspace.'
    )
    expect(verify.targets!.map((entry) => [entry.item.title, entry.unchecked])).toEqual([
      ['Ghost retry loop', true]
    ])
    expect(plan.calls.some((call) => /^verify\/r1\/.*a\d+$/.test(call.id))).toBe(false)
  })

  it('never lets JEV confirm a dropped result', () => {
    const base = discover()
    const spec = {
      ...base,
      steps: base.steps.map((step) =>
        step.jevVerify ? { ...step, jevVerify: { mode: 'live' as const, confirmAt: 0.9 } } : step
      )
    }
    const { plan } = run({ unsure: 'Listener leak' }, RULES, spec)
    expect(target(plan, 'Listener leak')).toMatchObject({ tally: 'confirmed', confirmedBy: 'jev' })
    const ghost = target(plan, 'Ghost retry loop')
    expect(ghost.jevVerify).toBe(0.99)
    expect(ghost.tally).toBe('unverified')
    expect(ghost.confirmedBy).toBeUndefined()
  })

  it('does not count a dropped result JEV refutes among the items over the limit', () => {
    const base = discover()
    const spec = {
      ...base,
      steps: base.steps.map((step) =>
        step.id === 'verify' ? { ...step, forEach: { ...step.forEach!, limit: 1 } } : step
      )
    }
    const { plan } = run({ p: { 'Ghost retry loop': 0.05 } }, RULES, spec)
    expect(target(plan, 'Ghost retry loop')).toMatchObject({ unchecked: true, refutedBy: 'jev' })
    expect(plan.runs.verify![0]!.setAside).toBe(1)
    expect(plan.outcome!.gaps.filter((gap) => gap.includes('over the limit'))).toEqual([
      'Verify (round 1): 1 item over the limit of 1 was not checked; it is listed as unverified.'
    ])
  })

  it('shows on each projected target and counts in the run result', () => {
    const { plan, outcomes, config } = run({})
    const snapshot = {
      graphProgramRevision: 1,
      seats: SEATS,
      task,
      access: 'workspace-read',
      host: { findRules: FIND_RULES, evidenceRules: EVIDENCE_RULES },
      graph: { spec: config.spec, agentSeats: config.agentSeats }
    }
    const view = projectGraphRun(snapshot as never, outcomes, false).graphRun
    const shown = view.steps.find((step) => step.id === 'verify')!.rounds[0]!.targets!
    const ghost = target(plan, 'Ghost retry loop').item.key
    expect(shown.find((entry) => entry.key === ghost)!.evidence).toEqual({
      status: 'unreadable',
      line: 5,
      preVerify: {
        flags: ['`src/ghost.ts` is not a file in the workspace.'],
        dropped: 'None of the files it cites exists in the workspace.'
      }
    })
    const settled = { state: 'completed', calls: [], startedAt: 0, graphRun: view }
    const started = { worktreeId: 'w', conversationId: 'c', executionId: 'e' }
    const result = workflowRunResult(settled as unknown as LocalWorkflowView, started, 'x', 1)
    expect(result.results.preVerify).toEqual({ checked: 3, dropped: 1, flagged: 1 })
    expect(result.results.targets.find((entry) => entry.key === ghost)!.preVerify).toEqual({
      flags: ['`src/ghost.ts` is not a file in the workspace.'],
      dropped: 'None of the files it cites exists in the workspace.'
    })
    const legacy = run({}, {})
    const legacyView = projectGraphRun(
      { ...snapshot, host: { findRules: FIND_RULES } } as never,
      legacy.outcomes,
      false
    ).graphRun
    const plain = workflowRunResult(
      { ...settled, graphRun: legacyView } as unknown as LocalWorkflowView,
      started,
      'x',
      1
    )
    expect(plain.results).not.toHaveProperty('preVerify')
  })
})
