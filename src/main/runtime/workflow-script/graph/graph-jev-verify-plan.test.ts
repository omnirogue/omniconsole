import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { workflowRunResult } from '../../../../shared/workflow-run-result'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import type { GraphConfig, GraphStepRun, GraphTarget, GraphVerifyRequest } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { graphJudgingGates } from './graph-judging-gates'
import { createGraphJevVerifier } from './graph-jev-verify'
import { GraphJevStore } from './graph-jev-store'
import { graphAttachJevVerify } from './graph-jev-verify-plan'
import { admittedDecisionRules, configFor, SEATS, task, text } from './graph-test-harness'
import { projectGraphRun } from '../local-workflow-graph-projection'

const found = (title: string, severity: string) => ({
  title,
  detail: `How ${title} breaks.`,
  location: `src/${title.replace(/\s+/g, '-')}.ts:12`,
  severity
})
const FOUND = [
  found('noisy log', 'critical'),
  found('lost write', 'low'),
  found('stale read', 'high'),
  found('typo', 'medium')
]
const KEYS = ['find.r1.1', 'find.r1.2', 'find.r1.3', 'find.r1.4']
const P: Record<string, number> = {
  'find.r1.1': 0.2,
  'find.r1.2': 0.97,
  'find.r1.3': 0.91,
  'find.r1.4': 0.05
}

type Mode = boolean | { mode: string; confirmAt?: number; rejectAt?: number }
/**
 * `final`: the review is the last step (its tallies are the outcome); `later`: round 2's finds;
 * `rootCause`: the triage folds find.r1.2 into find.r1.3 (checked first) as the same root cause;
 * `unsure`: the item every reviewer is UNSURE of (find.r1.2 unless set).
 */
type Shape = {
  limit?: number
  escalate?: number
  loop?: true
  final?: true
  later?: ReturnType<typeof found>[]
  rootCause?: true
  unsure?: string
  /** Round 1's finder also reports these; one matching a finding is merged into it. */
  extra?: ReturnType<typeof found>[]
}

/** Discover's verify shape: screened, impact-ordered, escalating, over the limit of 2. */
function spec(shadow: Mode, shape: Shape = {}) {
  const jevVerify = shadow === true ? { mode: 'shadow' } : shadow || undefined
  return normalizeWorkflowSpec({
    title: 'Shadow',
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: [{ route: 'claude' }],
        list: { maxItems: 8 }
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        agents: [{ route: 'claude' }, { route: 'codex' }, { route: 'grok' }],
        inputs: ['find'],
        forEach: {
          step: 'find',
          limit: shape.limit ?? 2,
          screen: { rubric: '- real?\n- specific?' },
          order: 'impact',
          ...(shape.rootCause ? { merge: 'root-cause' } : {})
        },
        escalate: { max: shape.escalate ?? 1, crossFamily: true },
        ...(jevVerify ? { jevVerify } : {})
      },
      ...(shape.final
        ? []
        : [
            {
              id: 'report',
              kind: 'synthesize',
              title: 'Report',
              agents: [{ route: 'claude' }],
              inputs: ['verify']
            }
          ])
    ],
    ...(shape.loop
      ? { repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 2 } }
      : {})
  })
}

type VerifyAnswer = 'ok' | 'fail' | 'error'

/** `refuted`: items every reviewer FAILs; one (find.r1.2 by default) is UNSURE, the rest PASS. */
function answer(verify: VerifyAnswer, p = P, refuted: readonly string[] = [], shape: Shape = {}) {
  return (call: GraphCall): unknown => {
    if (call.verify) {
      return verify === 'fail'
        ? undefined
        : verify === 'error'
          ? { markdown: 'off', error: 'JEV is turned off on this computer', probabilities: {} }
          : { markdown: 'verified', probabilities: p, model: 'jev-1.13.0', durationMs: 600 }
    }
    if (call.stepId === 'find') {
      const round1 = [...FOUND, ...(shape.extra ?? [])]
      return { items: call.id.startsWith('find/r2') ? (shape.later ?? FOUND) : round1 }
    }
    if (call.screen) {
      return { markdown: 'screened', scores: Object.fromEntries(KEYS.map((key) => [key, 3])) }
    }
    if (call.stepId === 'verify' && call.id.endsWith('/impact')) {
      const sameAs = (key: string) =>
        shape.rootCause && key === 'find.r1.2' ? { sameAs: 'find.r1.3' } : {}
      return {
        items: KEYS.map((key, index) => ({ key, impact: 5 - index, why: 'rated', ...sameAs(key) }))
      }
    }
    if (call.stepId === 'verify') {
      return text(
        call.id.includes(shape.unsure ?? 'find.r1.2')
          ? 'Maybe.\nVERDICT: UNSURE'
          : refuted.some((key) => call.id.includes(key))
            ? 'Guarded upstream.\nVERDICT: FAIL'
            : 'Traced.\nVERDICT: PASS'
      )
    }
    return text('Report')
  }
}

/** Drives the planner; a verify call is answered only once nothing else is ready. */
function run(
  shadow: Mode,
  verify: VerifyAnswer = 'ok',
  change: Partial<GraphConfig> = {},
  options: { shape?: Shape; p?: Record<string, number>; refuted?: string[] } = {}
) {
  const workflow = spec(shadow, options.shape)
  const config = { ...configFor(workflow), ...change }
  const outcomes = new Map<string, GraphOutcome>()
  const order: string[] = []
  const reply = answer(verify, options.p, options.refuted, options.shape)
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 30 && plan.ready.length; pass++) {
    const others = plan.ready.filter((call) => !call.verify)
    for (const call of others.length ? others : plan.ready) {
      order.push(call.id)
      const value = reply(call)
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return { plan, outcomes, order, config }
}

const withoutShadow = (targets: readonly GraphTarget[]) =>
  targets.map(({ jevVerify: _jevVerify, ...rest }) => rest)
const agentCalls = (calls: readonly GraphCall[]) =>
  calls.filter((call) => !call.verify).map((call) => [call.id, call.prompt, call.dependencies])

describe('shadow JEV verify', () => {
  it('is absent where a review does not ask for it (Discover asks for live)', () => {
    const discover = workflowTemplate('discover', ['claude', 'codex'])
    expect(discover.steps.filter((step) => step.jevVerify).map((step) => step.id)).toEqual([
      'verify'
    ])
    const { plan } = run(false)
    expect(plan.calls.some((call) => call.verify)).toBe(false)
    expect(plan.runs.verify[0].jevVerifyCall).toBeUndefined()
    expect(plan.runs.verify[0].targets!.some((target) => target.jevVerify !== undefined)).toBe(
      false
    )
  })

  it('asks once over every item, records p on each target, and changes nothing else', () => {
    const base = run(false)
    const shadow = run(true)
    const asked = shadow.plan.calls.filter((call) => call.verify)
    expect(asked.map((call) => call.id)).toEqual(['verify/jev-verify'])
    // Every item, not only the two the review has room for, each with the line it cites.
    expect(asked[0].verify!.items.map((item) => item.key)).toEqual(KEYS)
    expect(asked[0].verify!.items[0]).toMatchObject({ file: 'src/noisy-log.ts', line: 12 })
    expect(asked[0].verify!.scope).toContain('Goal: Question')
    const targets = shadow.plan.runs.verify[0].targets!
    expect(
      Object.fromEntries(targets.map((target) => [target.item.key, target.jevVerify]))
    ).toEqual(P)
    // Tallies, order, escalation, prompts, notes and the report are those of a run without it.
    expect(withoutShadow(targets)).toEqual(base.plan.runs.verify[0].targets)
    expect(agentCalls(shadow.plan.calls)).toEqual(agentCalls(base.plan.calls))
    expect(shadow.plan.runs.verify[0].calls).toEqual(base.plan.runs.verify[0].calls)
    expect(shadow.plan.runs.verify[0].notes).toEqual(base.plan.runs.verify[0].notes)
    expect(shadow.plan.outcome).toEqual(base.plan.outcome)
    // Never waited for: the report was written before JEV answered.
    expect(shadow.order.indexOf('report/a0')).toBeLessThan(
      shadow.order.indexOf('verify/jev-verify')
    )
  })

  it('names its contract under decision rules, and records a verify gate line', () => {
    const admitted = admittedDecisionRules(spec(true))
    const { plan, outcomes, config } = run(true, 'ok', admitted)
    const call = plan.calls.find((entry) => entry.verify)!
    expect(call.verify!.contract).toBe('generic-finding-verify@1')
    const gates = graphJudgingGates(config, task, plan, 'exec', 1, outcomes)
    expect(gates.find((gate) => gate.gate === 'verify')).toMatchObject({
      stepId: 'verify',
      callId: 'verify/jev-verify',
      contract: 'generic-finding-verify@1',
      decision: 'recorded',
      counts: { items: 4, scored: 4 },
      probabilities: P,
      jev: { status: 'done', model: 'jev-1.13.0', durationMs: 600 }
    })
  })

  it.each(['fail', 'error'] as const)(
    'a JEV %s leaves the run as it was, with no probability read as a no',
    (verify) => {
      const base = run(false)
      const shadow = run(true, verify)
      const targets = shadow.plan.runs.verify[0].targets!
      expect(targets.every((target) => target.jevVerify === undefined)).toBe(true)
      expect(targets).toEqual(base.plan.runs.verify[0].targets)
      expect(shadow.plan.outcome).toEqual(base.plan.outcome)
      expect(shadow.plan.outcome?.gaps).toEqual(base.plan.outcome?.gaps)
      const gate = graphJudgingGates(shadow.config, task, shadow.plan, 'exec', 1, shadow.outcomes)
      expect(gate.find((line) => line.gate === 'verify')).toMatchObject({
        decision: 'not recorded',
        counts: { items: 4, scored: 0 },
        jev: { status: 'failed' }
      })
    }
  )

  it('reaches `omni workflow run --json` as jevVerify on each target', () => {
    const target = {
      key: 'find.r1.2',
      title: 'lost write',
      detail: 'How it breaks.',
      location: 'src/lost-write.ts:12',
      severity: 'low',
      repeats: 0,
      tally: 'confirmed',
      votes: ['pass'],
      jevVerify: 0.97
    }
    const view = {
      state: 'completed',
      calls: [],
      startedAt: 0,
      graphRun: {
        spec: spec(true),
        steps: [{ id: 'verify', state: 'done', rounds: [{ round: 1, targets: [target] }] }],
        gaps: []
      }
    } as unknown as LocalWorkflowView
    const started = { worktreeId: 'w', conversationId: 'c', executionId: 'e' }
    const result = workflowRunResult(view, started, 'discover', 1)
    expect(result.results.targets[0]).toMatchObject({ key: 'find.r1.2', jevVerify: 0.97 })
  })
})

describe('live JEV verify', () => {
  // Three items reviewed (one refuted, one unsure, one passed), one over the limit.
  const shape = { limit: 3, escalate: 3 }
  const LIVE_P: Record<string, number> = {
    'find.r1.1': 0.95,
    'find.r1.2': 0.97,
    'find.r1.3': 0.1,
    'find.r1.4': 0.9
  }
  // The same run as JEV Lab saw it: an unsure item it rules out, an unchecked one it rates real.
  const DISCARD_P: Record<string, number> = {
    'find.r1.1': 0.95,
    'find.r1.2': 0.05,
    'find.r1.3': 0.02,
    'find.r1.4': 0.97
  }
  const live = (
    mode: Mode,
    verify: VerifyAnswer = 'ok',
    change: Partial<GraphConfig> = {},
    options: { shape?: Shape; p?: Record<string, number> } = {}
  ) => run(mode, verify, change, { shape, p: LIVE_P, refuted: ['find.r1.1'], ...options })
  const tallies = (targets: readonly GraphTarget[]) =>
    Object.fromEntries(
      targets.map((target) => {
        const by = target.confirmedBy ?? target.refutedBy
        return [target.item.key, `${target.tally}${by ? ` by ${by}` : ''}`]
      })
    )
  // Votes, texts and every other mark are the reviewers' own.
  const plain = (list: readonly GraphTarget[]) =>
    list.map(({ jevVerify: _p, confirmedBy: _c, refutedBy: _r, tally: _tally, ...rest }) => rest)
  const verifyRequest = (plan: ReturnType<typeof run>['plan']) =>
    plan.calls.find((call) => call.verify)!.verify!

  it('by default sets aside unverified targets at or below 0.1, and never confirms', () => {
    const base = live(false)
    expect(tallies(base.plan.runs.verify[0].targets!)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'unverified',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'unverified'
    })
    const discard = live({ mode: 'live' }, 'ok', {}, { p: DISCARD_P })
    const targets = discard.plan.runs.verify[0].targets!
    // Refuted at 0.95 and confirmed at 0.02 stand; unsure at 0.05 goes; unchecked at 0.97 stays.
    expect(tallies(targets)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'refuted by jev',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'unverified'
    })
    expect(targets.find((target) => target.item.key === 'find.r1.2')!.jevVerify).toBe(0.05)
    expect(plain(targets)).toEqual(plain(base.plan.runs.verify[0].targets!))
    expect(agentCalls(discard.plan.calls.filter((call) => !call.id.startsWith('report')))).toEqual(
      agentCalls(base.plan.calls.filter((call) => !call.id.startsWith('report')))
    )
    expect(discard.plan.runs.verify[0].notes).toContain(
      'Verify round 1: JEV set aside 1 item the reviewers left unverified, at p <= 0.1: find.r1.2 (p 0.05).'
    )
    expect(discard.plan.runs.verify[0].notes).toContain(
      'Verify round 1: live JEV verify sets aside at p <= 0.1 and never confirms.'
    )
    expect(discard.plan.runs.verify[0].notes.join('\n')).not.toContain('JEV confirmed')
    expect(verifyRequest(discard.plan)).toMatchObject({ rejectAt: 0.1 })
    expect(verifyRequest(discard.plan).confirmAt).toBeUndefined()
  })

  it('leaves an unverified target above rejectAt alone, and sets aside one at exactly it', () => {
    const p = { 'find.r1.1': 0.95, 'find.r1.2': 0.5, 'find.r1.3': 0.1, 'find.r1.4': 0.1 }
    const discard = live({ mode: 'live' }, 'ok', {}, { p })
    expect(tallies(discard.plan.runs.verify[0].targets!)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'unverified',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'refuted by jev'
    })
    const stricter = live({ mode: 'live', rejectAt: 0.04 }, 'ok', {}, { p: DISCARD_P })
    expect(tallies(stricter.plan.runs.verify[0].targets!)['find.r1.2']).toBe('unverified')
    expect(verifyRequest(stricter.plan).rejectAt).toBe(0.04)
  })

  it('confirms only unverified targets at or above an explicit confirmAt of 0.9', () => {
    const promoted = live({ mode: 'live', confirmAt: 0.9 })
    const targets = promoted.plan.runs.verify[0].targets!
    // Refuted at p 0.95 and confirmed at p 0.1 stand; unsure at 0.97 and unchecked at 0.9 promote.
    expect(tallies(targets)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'confirmed by jev',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'confirmed by jev'
    })
    expect(plain(targets)).toEqual(plain(live(false).plan.runs.verify[0].targets!))
    expect(promoted.plan.runs.verify[0].notes).toContain(
      'Verify round 1: JEV confirmed 2 items the reviewers left unverified, at p 0.9 or more: find.r1.2 (p 0.97), find.r1.4 (p 0.90).'
    )
    expect(verifyRequest(promoted.plan).confirmAt).toBe(0.9)
    expect(verifyRequest(promoted.plan).rejectAt).toBeUndefined()
    // Without confirmAt the same probabilities confirm nothing.
    expect(tallies(live({ mode: 'live' }).plan.runs.verify[0].targets!)).toEqual(
      tallies(live(false).plan.runs.verify[0].targets!)
    )
  })

  it('leaves targets below confirmAt unchanged', () => {
    const strict = live({ mode: 'live', confirmAt: 0.96 })
    expect(tallies(strict.plan.runs.verify[0].targets!)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'confirmed by jev',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'unverified'
    })
    expect(verifyRequest(strict.plan).confirmAt).toBe(0.96)
  })

  it('keeps a spec that sets only confirmAt confirm-only; both thresholds do both', () => {
    const confirmOnly = live({ mode: 'live', confirmAt: 0.9 }, 'ok', {}, { p: DISCARD_P })
    // Unsure at 0.05 is left alone: the default set-aside applies only when neither is set.
    expect(tallies(confirmOnly.plan.runs.verify[0].targets!)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'unverified',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'confirmed by jev'
    })
    expect(confirmOnly.plan.runs.verify[0].notes).toContain(
      'Verify round 1: live JEV verify never sets aside and confirms at p >= 0.9.'
    )
    const both = live({ mode: 'live', confirmAt: 0.9, rejectAt: 0.1 }, 'ok', {}, { p: DISCARD_P })
    expect(tallies(both.plan.runs.verify[0].targets!)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'refuted by jev',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'confirmed by jev'
    })
    expect(verifyRequest(both.plan)).toMatchObject({ confirmAt: 0.9, rejectAt: 0.1 })
  })

  it('applies the thresholds of the recorded request, not those of the spec today', () => {
    const step = spec({ mode: 'live' }, shape).steps.find((entry) => entry.id === 'verify')!
    const decide = (verify: Partial<GraphVerifyRequest>, p: number) => {
      const item = { key: 'k', title: 'k', detail: '', location: '', severity: 'low', repeats: 0 }
      const target = { item, votes: [null], texts: [null], tally: 'unverified' } as GraphTarget
      const stepRun = {
        stepId: 'verify',
        round: 1,
        state: 'done',
        calls: [],
        notes: [],
        targets: [target],
        jevVerifyCall: 'verify/jev-verify'
      } as unknown as GraphStepRun
      const scope = {
        calls: [{ id: 'verify/jev-verify', verify: { scope: '', items: [], ...verify } }],
        outcomes: new Map([['verify/jev-verify', { value: { probabilities: { k: p } } }]])
      } as unknown as GraphScope
      graphAttachJevVerify(scope, step, stepRun)
      return stepRun.targets![0]!.tally
    }
    // The spec's default is 0.1; the request recorded 0.2, and 0.2 decides.
    expect(decide({ rejectAt: 0.2 }, 0.15)).toBe('refuted')
    // A request recorded under @2 carries no rejectAt: it never sets aside, even at p 0.
    expect(decide({ confirmAt: 0.9 }, 0)).toBe('unverified')
    expect(decide({}, 0)).toBe('unverified')
  })

  it.each(['fail', 'error'] as const)('a JEV %s is the same run as no JEV at all', (verify) => {
    const base = live(false, 'ok', {}, { p: DISCARD_P })
    const failed = live({ mode: 'live' }, verify, {}, { p: DISCARD_P })
    expect(failed.plan.runs.verify[0].targets).toEqual(base.plan.runs.verify[0].targets)
    expect(failed.plan.runs.verify[0].notes).toEqual(base.plan.runs.verify[0].notes)
    // A healthy live round that sets nothing aside still logs its rule; a failed one logs nothing.
    const healthy = live({ mode: 'live' }).plan.runs.verify[0].notes
    expect(healthy).toContain(
      'Verify round 1: live JEV verify sets aside at p <= 0.1 and never confirms.'
    )
    expect(failed.plan.runs.verify[0].notes).not.toEqual(healthy)
    expect(failed.plan.outcome).toEqual(base.plan.outcome)
    const gates = graphJudgingGates(failed.config, task, failed.plan, 'exec', 1, failed.outcomes)
    expect(gates.find((line) => line.gate === 'verify')).toMatchObject({
      decision: 'not recorded',
      counts: { items: 4, scored: 0, refuted: 0 },
      refuted: []
    })
  })

  it('makes the report wait for JEV, which shadow mode never does', () => {
    const promoted = live({ mode: 'live', confirmAt: 0.9 })
    expect(promoted.order.indexOf('verify/jev-verify')).toBeLessThan(
      promoted.order.indexOf('report/a0')
    )
    const shadow = live(true)
    expect(shadow.order.indexOf('report/a0')).toBeLessThan(
      shadow.order.indexOf('verify/jev-verify')
    )
    // The report reads JEV's confirmations as confirmed, and says which were JEV's, with p.
    const prompt = promoted.plan.calls.find((call) => call.id === 'report/a0')!.prompt
    const confirmed = prompt.slice(prompt.indexOf('### Confirmed (3)'))
    expect(confirmed).toContain('lost write')
    expect(confirmed).toContain('confirmed by JEV (p 0.97), not by a reviewer')
    expect(confirmed).toContain('confirmed by JEV (p 0.90), not by a reviewer')
    expect(prompt).not.toContain('Not checked, over the verification limit')
    expect(shadow.plan.calls.find((call) => call.id === 'report/a0')!.prompt).not.toContain(
      'confirmed by JEV'
    )
  })

  it("lists a set-aside under Refuted, labelled as JEV's, even one no reviewer saw", () => {
    const p = { 'find.r1.1': 0.95, 'find.r1.2': 0.5, 'find.r1.3': 0.1, 'find.r1.4': 0.04 }
    const discard = live({ mode: 'live' }, 'ok', {}, { p })
    const prompt = discard.plan.calls.find((call) => call.id === 'report/a0')!.prompt
    const refuted = prompt.slice(prompt.indexOf('### Refuted (2)'))
    expect(refuted).toContain('set aside by JEV (p 0.04), not refuted by a reviewer')
    expect(prompt).not.toContain('Not checked, over the verification limit')
  })

  it('keeps the loop rule: a promotion or a set-aside is not a new finding', () => {
    const loop = { shape: { ...shape, loop: true as const } }
    const base = live(false, 'ok', {}, loop)
    for (const mode of [{ mode: 'live', confirmAt: 0.9 }, { mode: 'live' }]) {
      for (const p of [LIVE_P, DISCARD_P]) {
        const changed = live(mode, 'ok', {}, { ...loop, p })
        expect(changed.plan.loop).toEqual(base.plan.loop)
        expect(changed.plan.runs.find.map((entry) => entry.state)).toEqual(
          base.plan.runs.find.map((entry) => entry.state)
        )
        expect(changed.plan.runs.verify.map((entry) => entry.state)).toEqual(
          base.plan.runs.verify.map((entry) => entry.state)
        )
      }
    }
  })

  it('freezes version 3 of the contract and records its set-asides on the gate line', () => {
    const admitted = admittedDecisionRules(spec({ mode: 'live' }, shape))
    const { plan, outcomes, config } = live({ mode: 'live' }, 'ok', admitted, { p: DISCARD_P })
    expect(verifyRequest(plan).contract).toBe('generic-finding-verify@3')
    const gates = graphJudgingGates(config, task, plan, 'exec', 1, outcomes)
    const line = gates.find((gate) => gate.gate === 'verify')!
    expect(line).toMatchObject({
      contract: 'generic-finding-verify@3',
      decision: 'set aside',
      counts: { items: 4, scored: 4, refuted: 1 },
      rejectAt: 0.1,
      refuted: ['find.r1.2'],
      probabilities: DISCARD_P
    })
    expect(line.confirmAt).toBeUndefined()
    expect(line.counts!.confirmed).toBeUndefined()
  })

  it("keeps version 2's rule for a run frozen under it: confirm at 0.9, never set aside", () => {
    const admitted = admittedDecisionRules(spec({ mode: 'live' }, shape))
    const frozen = {
      ...admitted,
      contracts: { ...admitted.contracts, 'verify/verify': 'generic-finding-verify@2' as const }
    }
    const { plan, outcomes, config } = live({ mode: 'live' }, 'ok', frozen, { p: DISCARD_P })
    expect(verifyRequest(plan)).toEqual(expect.objectContaining({ confirmAt: 0.9 }))
    expect(verifyRequest(plan).rejectAt).toBeUndefined()
    expect(tallies(plan.runs.verify[0].targets!)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'unverified',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'confirmed by jev'
    })
    const gates = graphJudgingGates(config, task, plan, 'exec', 1, outcomes)
    expect(gates.find((gate) => gate.gate === 'verify')).toMatchObject({
      contract: 'generic-finding-verify@2',
      decision: 'confirmed',
      counts: { items: 4, scored: 4, confirmed: 1 },
      confirmAt: 0.9,
      confirmed: ['find.r1.4']
    })
  })

  it('reads a missing or non-finite probability as no answer, never as a no', () => {
    const p = { 'find.r1.2': Number.NaN, 'find.r1.4': 0.05 }
    const { plan } = live({ mode: 'live' }, 'ok', {}, { p })
    const targets = plan.runs.verify[0].targets!
    expect(tallies(targets)).toEqual({
      'find.r1.1': 'refuted',
      'find.r1.2': 'unverified',
      'find.r1.3': 'confirmed',
      'find.r1.4': 'refuted by jev'
    })
    expect(targets.filter((target) => target.jevVerify !== undefined)).toHaveLength(1)
    // p 0 is a finite answer and is set aside; a string is no answer at all.
    const odd = { 'find.r1.2': 0, 'find.r1.4': '0.05' as unknown as number }
    const zero = live({ mode: 'live' }, 'ok', {}, { p: odd }).plan.runs.verify[0].targets!
    expect(tallies(zero)).toMatchObject({
      'find.r1.2': 'refuted by jev',
      'find.r1.4': 'unverified'
    })
    expect(zero.map((target) => target.jevVerify)).toEqual([undefined, 0, undefined, undefined])
    const oddRun = live({ mode: 'live' }, 'ok', {}, { p: odd })
    const gates = graphJudgingGates(oddRun.config, task, oddRun.plan, 'exec', 1, oddRun.outcomes)
    expect(gates.find((line) => line.gate === 'verify')!.counts).toMatchObject({ scored: 1 })
  })

  describe('a finding merged from several reports', () => {
    // find.r1.2 is folded into find.r1.3, which every reviewer leaves unsure.
    const merged = (mode: Mode, p: Record<string, number>) => {
      const folded = { ...shape, rootCause: true as const, unsure: 'find.r1.3' }
      const result = live(mode, 'ok', {}, { shape: folded, p })
      const round = result.plan.runs.verify[0]
      const target = round.targets!.find((entry) => entry.item.key === 'find.r1.3')!
      const gates = graphJudgingGates(result.config, task, result.plan, 'exec', 1, result.outcomes)
      return { target, notes: round.notes, gate: gates.find((line) => line.gate === 'verify')! }
    }
    const p = (leader: number, member?: number) => ({
      'find.r1.1': 0.95,
      'find.r1.3': leader,
      'find.r1.4': 0.97,
      ...(member === undefined ? {} : { 'find.r1.2': member })
    })

    it('is set aside only when every member is at or below rejectAt', () => {
      // The leader alone at 0.05 must not discard a member JEV rated real, or never answered.
      for (const probabilities of [p(0.05, 0.97), p(0.05)]) {
        const { target, gate } = merged({ mode: 'live' }, probabilities)
        expect(target.tally).toBe('unverified')
        expect(target.refutedBy).toBeUndefined()
        expect(gate.members).toBeUndefined()
      }
      const { target, notes, gate } = merged({ mode: 'live' }, p(0.05, 0.08))
      expect(target).toMatchObject({ tally: 'refuted', refutedBy: 'jev', jevVerify: 0.08 })
      expect(notes).toContain(
        'Verify round 1: JEV set aside 1 item the reviewers left unverified, at p <= 0.1: find.r1.3 (p 0.08: find.r1.3 0.05, find.r1.2 0.08).'
      )
      expect(gate.members).toEqual({ 'find.r1.3': { 'find.r1.3': 0.05, 'find.r1.2': 0.08 } })
    })

    it('is confirmed only when every member is at or above confirmAt', () => {
      const low = merged({ mode: 'live', confirmAt: 0.9 }, p(0.97, 0.6))
      expect(low.target.tally).toBe('unverified')
      expect(low.target.confirmedBy).toBeUndefined()
      const high = merged({ mode: 'live', confirmAt: 0.9 }, p(0.97, 0.92))
      expect(high.target).toMatchObject({ tally: 'confirmed', confirmedBy: 'jev', jevVerify: 0.92 })
      expect(high.gate.members).toEqual({ 'find.r1.3': { 'find.r1.3': 0.97, 'find.r1.2': 0.92 } })
    })
  })

  it('puts a set-aside back to unverified when a later round reports it with new evidence', () => {
    const reworded = { ...FOUND[1]!, detail: 'Also lost when the retry times out.' }
    const loop = (later: ReturnType<typeof found>[]) =>
      live({ mode: 'live' }, 'ok', {}, { shape: { ...shape, loop: true, later }, p: DISCARD_P })
    const prompt = (plan: ReturnType<typeof run>['plan']) =>
      plan.calls.find((call) => call.id === 'report/a0')!.prompt
    // An exact copy of the report JEV saw carries nothing new: the set-aside stands.
    const same = loop(FOUND)
    expect(prompt(same.plan)).toContain('set aside by JEV (p 0.05), not refuted by a reviewer')
    // New evidence JEV never saw: listed unverified with it, a reviewer's refutation unchanged.
    const again = loop([reworded])
    const report = prompt(again.plan)
    expect(report).not.toContain('set aside by JEV (p 0.05)')
    const resurfaced = report.slice(report.indexOf('### Unverified after review: reported again'))
    expect(resurfaced).toContain('lost write')
    expect(resurfaced).toContain('Also lost when the retry times out.')
    expect(report).toContain('### Refuted (1)')
    expect(again.plan.notes).toContain(
      'Verify: 1 item JEV set aside was reported again in a later round, so the report lists it as unverified.'
    )
    expect(report).toContain('JEV set it aside (p 0.05) before a later report it never saw')
    // The desktop view and `--json` read the same: unverified, reported again, with its p.
    const projected = (result: ReturnType<typeof run>) => {
      const snapshot = { graphProgramRevision: 1, seats: SEATS, task, access: 'frozen' }
      const graph = { spec: result.config.spec, agentSeats: result.config.agentSeats }
      return projectGraphRun({ ...snapshot, graph } as never, result.outcomes, false).graphRun
    }
    const view = projected(again)
    const shown = view.steps.find((step) => step.id === 'verify')!.rounds[0]!.targets!
    expect(shown.find((target) => target.key === 'find.r1.2')).toMatchObject({
      tally: 'unverified',
      resurfaced: true,
      setAsideAt: 0.05,
      jevVerify: 0.05
    })
    const started = { worktreeId: 'w', conversationId: 'c', executionId: 'e' }
    const settled = { state: 'completed', calls: [], startedAt: 0, graphRun: view }
    const json = workflowRunResult(
      settled as unknown as LocalWorkflowView,
      started,
      'discover',
      1
    ).results.targets.find((target) => target.key === 'find.r1.2')!
    expect(json).toMatchObject({ tally: 'unverified', resurfaced: true, setAsideAt: 0.05 })
    expect(json.refutedBy).toBeUndefined()
    const kept = projected(same).steps.find((step) => step.id === 'verify')!.rounds[0]!.targets!
    expect(kept.find((target) => target.key === 'find.r1.2')).toMatchObject({
      tally: 'refuted',
      refutedBy: 'jev'
    })
  })

  it('resurfaces a set-aside when a later report reaches it through a root-cause merge', () => {
    // find.r1.2 is folded into find.r1.3, which reviewers leave unsure; JEV rates both not real.
    const p = { 'find.r1.1': 0.95, 'find.r1.2': 0.08, 'find.r1.3': 0.05, 'find.r1.4': 0.97 }
    const merged = (later: ReturnType<typeof found>[]) =>
      live(
        { mode: 'live' },
        'ok',
        {},
        {
          shape: { ...shape, loop: true, rootCause: true, unsure: 'find.r1.3', later },
          p
        }
      )
    const round = merged(FOUND).plan.runs.verify[0].targets!
    expect(tallies(round)['find.r1.3']).toBe('refuted by jev')
    expect(round.find((target) => target.item.key === 'find.r1.3')!.item.alsoMerged).toEqual([
      'find.r1.2'
    ])
    // A new report of the folded item, filed under its own key, still reopens the leader.
    const again = merged([{ ...FOUND[1]!, detail: 'Lost after failover too.' }])
    const report = again.plan.calls.find((call) => call.id === 'report/a0')!.prompt
    const resurfaced = report.slice(report.indexOf('### Unverified after review: reported again'))
    expect(resurfaced).toContain('stale read')
    expect(resurfaced).toContain('Lost after failover too.')
    expect(again.plan.notes).toContain(
      'Verify: 1 item JEV set aside was reported again in a later round, so the report lists it as unverified.'
    )
    const unchanged = merged(FOUND).plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(unchanged).toContain('set aside by JEV (p 0.08), not refuted by a reviewer')
    expect(report).toContain('JEV set it aside (p 0.08) before a later report it never saw')
  })

  it("marks a set-aside as JEV's in the outcome when the review is the last step", () => {
    const p = { 'find.r1.1': 0.95, 'find.r1.2': 0.5, 'find.r1.3': 0.1, 'find.r1.4': 0.04 }
    const { plan } = live({ mode: 'live' }, 'ok', {}, { shape: { ...shape, final: true }, p })
    const markdown = plan.outcome!.final!.markdown
    const refuted = markdown.slice(markdown.indexOf('## Refuted (2)'))
    expect(refuted).toContain('_set aside by JEV (p 0.04), not refuted by a reviewer_')
    expect(refuted.match(/set aside by JEV/g)).toHaveLength(1)
    // The one over the limit was never checked, and the gap says JEV decided it.
    expect(plan.outcome!.gaps).toContain(
      'Verify: 1 item over the limit of 3 was not checked; JEV verify decided it.'
    )
  })

  it('never decides a finding carrying a merged report JEV did not read', () => {
    // Same title and place, another claim: Find merges it into find.r1.2, whose report JEV read.
    const retry = { ...FOUND[1]!, detail: 'Retry writes are lost when the queue is full.' }
    const merged = (mode: Mode, p: Record<string, number>, extra: ReturnType<typeof found>[]) => {
      const result = live(mode, 'ok', {}, { shape: { ...shape, extra }, p })
      const round = result.plan.runs.verify[0]
      const gates = graphJudgingGates(result.config, task, result.plan, 'exec', 1, result.outcomes)
      return { round, gate: gates.find((line) => line.gate === 'verify')! }
    }
    const held = merged({ mode: 'live' }, DISCARD_P, [retry])
    expect(tallies(held.round.targets!)['find.r1.2']).toBe('unverified')
    expect(held.round.notes).toContain(
      'Verify round 1: JEV left 1 item unverified that it would have decided, as each carries a merged report it did not read: find.r1.2 (p 0.05; 1 merged report JEV did not read).'
    )
    expect(held.gate).toMatchObject({ refuted: [], unread: { 'find.r1.2': 1 } })
    // A merged copy of the very text JEV read (only its severity differs) decides as usual.
    const copy = merged({ mode: 'live' }, DISCARD_P, [{ ...FOUND[1]!, severity: 'high' }])
    const lost = copy.round.targets!.find((target) => target.item.key === 'find.r1.2')!
    expect(lost.item.alsoReported).toHaveLength(1)
    expect(tallies(copy.round.targets!)['find.r1.2']).toBe('refuted by jev')
    expect(copy.gate.unread).toBeUndefined()
    // The confirm side holds the same way.
    const confirm = merged({ mode: 'live', confirmAt: 0.9 }, LIVE_P, [retry])
    expect(tallies(confirm.round.targets!)['find.r1.2']).toBe('unverified')
    expect(confirm.gate).toMatchObject({ confirmed: ['find.r1.4'], unread: { 'find.r1.2': 1 } })
  })

  it('replays a run recorded under @2 from its JEV record: the request byte for byte', async () => {
    const admitted = admittedDecisionRules(spec({ mode: 'live' }, shape))
    const frozen = {
      ...admitted,
      contracts: { ...admitted.contracts, 'verify/verify': 'generic-finding-verify@2' as const }
    }
    const call = live({ mode: 'live' }, 'ok', frozen, { p: DISCARD_P }).plan.calls.find(
      (entry) => entry.verify
    )!
    // The request exactly as the @2 build (main-next 7552e2b0ea) wrote it, and its digest.
    const cited = (key: string, title: string) => {
      const file = `src/${title.replace(/\s+/g, '-')}.ts`
      return { key, title, location: `${file}:12`, detail: `How ${title} breaks.`, file, line: 12 }
    }
    const recorded = {
      scope: 'Goal: Question',
      items: [
        cited('find.r1.1', 'noisy log'),
        cited('find.r1.2', 'lost write'),
        cited('find.r1.3', 'stale read'),
        cited('find.r1.4', 'typo')
      ],
      contract: 'generic-finding-verify@2',
      confirmAt: 0.9
    }
    const digest = '3af329afceb176d2e22664bf8a3ee2791c20ccd040df4f810fe390dd69fca138'
    expect(JSON.stringify(call.verify)).toBe(JSON.stringify(recorded))
    expect(createHash('sha256').update(JSON.stringify(call.verify)).digest('hex')).toBe(digest)
    const dir = mkdtempSync(join(tmpdir(), 'graph-verify-v2-'))
    try {
      const store = GraphJevStore.forExecution('exec', dir)
      const value = { markdown: 'recorded', probabilities: DISCARD_P }
      store.write(call.id, { digest, outcome: { value }, at: 1 })
      const replay = createGraphJevVerifier({ store, cacheOnly: true })
      await expect(replay(call)).resolves.toEqual({ value })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reaches `omni workflow run --json` as confirmedBy or refutedBy on each target', () => {
    const target = (key: string, tally: string, by?: object) => ({
      key,
      title: key,
      detail: 'How it breaks.',
      location: 'src/a.ts:1',
      severity: 'low',
      repeats: 0,
      tally,
      votes: [],
      jevVerify: 0.97,
      ...by
    })
    const view = {
      state: 'completed',
      calls: [],
      startedAt: 0,
      graphRun: {
        spec: spec({ mode: 'live' }),
        steps: [
          {
            id: 'verify',
            state: 'done',
            rounds: [
              {
                round: 1,
                targets: [
                  target('a', 'confirmed', { confirmedBy: 'jev' }),
                  target('b', 'confirmed'),
                  target('c', 'refuted', { refutedBy: 'jev' }),
                  target('d', 'refuted')
                ]
              }
            ]
          }
        ],
        gaps: []
      }
    } as unknown as LocalWorkflowView
    const started = { worktreeId: 'w', conversationId: 'c', executionId: 'e' }
    const [jev, reviewer, setAside, refuted] = workflowRunResult(view, started, 'discover', 1)
      .results.targets
    expect(jev).toMatchObject({ key: 'a', tally: 'confirmed', confirmedBy: 'jev' })
    expect(reviewer!.confirmedBy).toBeUndefined()
    expect(setAside).toMatchObject({ key: 'c', tally: 'refuted', refutedBy: 'jev' })
    expect(refuted!.refutedBy).toBeUndefined()
  })
})
