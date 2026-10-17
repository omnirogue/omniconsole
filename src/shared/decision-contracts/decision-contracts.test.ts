import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JEV_AUTO_PAIRWISE_MAX,
  JEV_SCORE_MARGIN,
  JEV_UNSURE_BAND,
  JEV_VERIFY_BAND,
  JEV_VERIFY_QUESTION,
  ONE_ANSWER_QUESTION
} from '../jev-confidence'
import { WORKFLOW_SCREEN_SET_ASIDE, type WorkflowSpec } from '../workflow-graph'
import { workflowSetOneAnswer } from '../workflow-graph-decide'
import { screenedDiscover } from '../workflow-discover-screen.test-fixture'
import { workflowTemplate, type WorkflowTemplateKey } from '../workflow-graph-templates'
import { ONE_ANSWER_UNSURE_BAND } from '../workflow-one-answer'
import {
  contractByRef,
  DECISION_CONTRACTS,
  DEFAULT_CONTRACTS,
  GENERIC_CONTRACTS,
  LEGACY_CONTRACTS
} from './decision-contract-library'
import {
  contractRefOf,
  DECISION_KINDS,
  UNKNOWN_OUTCOMES,
  type DecisionContract
} from './decision-contract-types'
import { resolveDecisionContracts, workflowDecisionPoints } from './decision-points'

const ROUTES = ['claude', 'codex', 'grok'] as const
// Read, not imported: the CLI typecheck project does not list JSON files.
const digests: unknown = JSON.parse(
  readFileSync(join(__dirname, 'decision-contract-digests.json'), 'utf8')
)

// Sorted keys, so a digest changes only when a contract's content does.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

const digestOf = (contract: DecisionContract) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(contract)))
    .digest('hex')

const template = (key: WorkflowTemplateKey) => workflowTemplate(key, ROUTES)

describe('decision points of the built-in templates', () => {
  const cases: [string, WorkflowSpec, Record<string, string>][] = [
    [
      'Council',
      template('council'),
      { 'rank/ballot': 'council-peer-rank@1', 'final-check': 'council-final-check@1' }
    ],
    // Discover has no screen (2026-09-27); its only JEV decision is live verify, on by default.
    ['Discover', template('discover'), { 'verify/verify': 'discover-verify@3' }],
    [
      'Discover (quick)',
      workflowTemplate('discover', ROUTES, { depth: 'quick' }),
      { 'verify/verify': 'discover-verify@3' }
    ],
    ['Improve', template('improve'), { 'judge/ballot': 'improve-judge@1' }],
    [
      'Find the best',
      template('find'),
      { 'judge/screen': 'find-screen@2', 'judge/ballot': 'find-final@1' }
    ],
    [
      'Best of N',
      template('best-of-n'),
      { 'judge/screen': 'find-screen@2', 'judge/ballot': 'find-final@1' }
    ],
    [
      'Decide',
      template('decide'),
      {
        'develop/shortlist': 'decide-shortlist@1',
        'compare/line': 'decide-compare-line@1',
        'final-check': 'decide-final-check@1'
      }
    ],
    [
      'Decide with one-answer routing',
      workflowSetOneAnswer(template('decide'), true, ROUTES),
      {
        route: 'decide-one-answer@1',
        'develop/shortlist': 'decide-shortlist@1',
        'compare/line': 'decide-compare-line@1',
        'final-check': 'decide-final-check@1'
      }
    ],
    ['Research panel', template('research-panel'), {}],
    ['Investigate', template('investigate'), {}]
  ]

  it('adds the shadow verify point only when a review asks for it', () => {
    const discover = template('discover')
    const shadow: WorkflowSpec = {
      ...discover,
      steps: discover.steps.map((step) =>
        step.id === 'verify' ? { ...step, jevVerify: { mode: 'shadow' } } : step
      )
    }
    expect(resolveDecisionContracts(shadow)).toEqual({ 'verify/verify': 'discover-verify@1' })
    expect(resolveDecisionContracts({ ...shadow, template: 'custom' })).toEqual({
      'verify/verify': 'generic-finding-verify@1'
    })
  })

  it('still resolves the set-aside gate where a spec puts the screen back on Discover', () => {
    expect(resolveDecisionContracts(screenedDiscover(ROUTES))).toEqual({
      'verify/set-aside': 'discover-set-aside@1'
    })
  })

  it.each(cases)('%s resolves every JEV decision to its contract', (_name, spec, expected) => {
    expect(resolveDecisionContracts(spec)).toEqual(expected)
    for (const point of workflowDecisionPoints(spec)) {
      expect(contractByRef(expected[point.key]!).kind).toBe(point.kind)
    }
  })

  it.each([[['claude'] as const], [['claude', 'codex', 'grok', 'gemini', 'openrouter'] as const]])(
    'resolves the same contracts with routes %j',
    (routes) => {
      for (const [, spec, expected] of cases) {
        const key = spec.template === 'custom' ? 'research-panel' : spec.template
        const quick = spec.template === 'discover' && !spec.repeat
        const built = workflowTemplate(
          key as WorkflowTemplateKey,
          routes,
          quick ? { depth: 'quick' } : {}
        )
        const routed = spec.oneAnswer ? workflowSetOneAnswer(built, true, routes) : built
        expect(resolveDecisionContracts(routed)).toEqual(expected)
      }
    }
  )

  it('falls back to the generic contract of each kind outside a template', () => {
    const custom = (spec: WorkflowSpec): WorkflowSpec => ({ ...spec, template: 'custom' })
    expect(resolveDecisionContracts(custom(template('council')))).toEqual({
      'rank/ballot': 'generic-rank-ballot@1',
      'final-check': 'generic-final-check@1'
    })
    expect(resolveDecisionContracts(custom(screenedDiscover(ROUTES)))).toEqual({
      'verify/set-aside': 'generic-set-aside-gate@1'
    })
    expect(
      resolveDecisionContracts(custom(workflowSetOneAnswer(template('decide'), true, ROUTES)))
    ).toEqual({
      route: 'generic-one-answer-route@1',
      'develop/shortlist': 'generic-hard-limit-gate@1',
      'compare/line': 'generic-criterion-line@1',
      'final-check': 'generic-final-check@1'
    })
    expect(resolveDecisionContracts(custom(template('find')))).toEqual({
      'judge/screen': 'generic-screen-order@2',
      'judge/ballot': 'generic-rank-ballot@1'
    })
  })

  it('keeps @1 for runs frozen before decision rules, Find included', () => {
    expect(resolveDecisionContracts(template('find'), LEGACY_CONTRACTS)).toEqual({
      'judge/screen': 'find-screen@1',
      'judge/ballot': 'find-final@1'
    })
    const custom: WorkflowSpec = { ...template('find'), template: 'custom' }
    expect(resolveDecisionContracts(custom, LEGACY_CONTRACTS)['judge/screen']).toBe(
      'generic-screen-order@1'
    )
    // Only Find's screen moved: every other point resolves as it did before.
    for (const [, spec] of cases) {
      const now = resolveDecisionContracts(spec)
      const then = resolveDecisionContracts(spec, LEGACY_CONTRACTS)
      for (const [key, ref] of Object.entries(then)) {
        expect(now[key]).toBe(ref === 'find-screen@1' ? 'find-screen@2' : ref)
      }
    }
  })

  it('resolves a live verify point to version 3, which discards only; version 2 stays', () => {
    const discover = template('discover')
    const live = (jevVerify: WorkflowSpec['steps'][number]['jevVerify']): WorkflowSpec => ({
      ...discover,
      steps: discover.steps.map((step) => (step.id === 'verify' ? { ...step, jevVerify } : step))
    })
    const verifyRef = (spec: WorkflowSpec) => resolveDecisionContracts(spec)['verify/verify']
    expect(verifyRef(live({ mode: 'shadow' }))).toBe('discover-verify@1')
    expect(verifyRef(live({ mode: 'live' }))).toBe('discover-verify@3')
    expect(verifyRef(live({ mode: 'live', confirmAt: 0.95 }))).toBe('discover-verify@3')
    expect(verifyRef({ ...live({ mode: 'live' }), template: 'custom' })).toBe(
      'generic-finding-verify@3'
    )
    for (const ref of ['discover-verify@3', 'generic-finding-verify@3']) {
      const contract = contractByRef(ref)
      expect(contract).toMatchObject({ kind: 'finding-verify', version: 3, harm: 'false-no' })
      expect(contract.gates.map((gate) => gate.id)).toEqual([
        'verify',
        'set-aside',
        'confirm',
        'never-against'
      ])
      expect(contract.gates[1]!.means).toContain('0.01–0.2; 0.1 when the step sets neither')
      expect(contract.gates[2]!.means).toContain('Only when the step sets confirmAt')
    }
    // Runs frozen under @2 still resolve it.
    for (const ref of ['discover-verify@2', 'generic-finding-verify@2']) {
      const contract = contractByRef(ref)
      expect(contract).toMatchObject({ kind: 'finding-verify', version: 2 })
      expect(contract.gates.map((gate) => gate.id)).toEqual(['verify', 'confirm', 'never-against'])
      expect(contract.gates[1]!.means).toContain('0.9 unless set, 0.8–0.99')
    }
    // Shadow's @1 is unchanged by the live version beside it.
    expect(contractByRef('discover-verify@1').gates.map((gate) => gate.id)).toEqual([
      'verify',
      'shadow'
    ])
  })

  it('has no ballot when a Rank step has no JEV judge', () => {
    const spec = template('council')
    const noJev: WorkflowSpec = {
      ...spec,
      steps: spec.steps.map(({ jev: _jev, ...step }) => step)
    }
    expect(resolveDecisionContracts(noJev)).toEqual({ 'final-check': 'council-final-check@1' })
  })
})

describe('version 1 describes today exactly', () => {
  it("keeps today's values", () => {
    expect(JEV_SCORE_MARGIN).toBe(0.5)
    expect(JEV_UNSURE_BAND).toEqual([0.2, 0.8])
    expect(JEV_AUTO_PAIRWISE_MAX).toBe(5)
    expect(ONE_ANSWER_UNSURE_BAND).toEqual([0.35, 0.65])
    expect(WORKFLOW_SCREEN_SET_ASIDE).toBe(1)
    expect(ONE_ANSWER_QUESTION).toBe(
      'Does state.question have one right answer that could be checked (a fact, a computation or a lookup), rather than calling for judgment between reasonable positions?'
    )
  })

  it('reads every threshold from the constant the runtime uses', () => {
    const auto = {
      method: 'auto',
      pairwiseUpTo: JEV_AUTO_PAIRWISE_MAX,
      scoreMargin: JEV_SCORE_MARGIN,
      pairBand: JEV_UNSURE_BAND
    }
    const line = { method: 'score-line', below: WORKFLOW_SCREEN_SET_ASIDE }
    const verify = { method: 'noul', question: JEV_VERIFY_QUESTION, band: JEV_VERIFY_BAND }
    const expected: Record<string, unknown> = {
      'council-peer-rank@1': auto,
      'improve-judge@1': auto,
      'find-final@1': auto,
      'generic-rank-ballot@1': auto,
      'council-final-check@1': auto,
      'decide-final-check@1': auto,
      'generic-final-check@1': auto,
      'decide-compare-line@1': { method: 'pairwise', pairBand: JEV_UNSURE_BAND },
      'generic-criterion-line@1': { method: 'pairwise', pairBand: JEV_UNSURE_BAND },
      'find-screen@1': { method: 'scores' },
      'generic-screen-order@1': { method: 'scores' },
      'find-screen@2': { method: 'scores' },
      'generic-screen-order@2': { method: 'scores' },
      'discover-set-aside@1': line,
      'generic-set-aside-gate@1': line,
      'decide-shortlist@1': line,
      'generic-hard-limit-gate@1': line,
      'decide-one-answer@1': {
        method: 'noul',
        question: ONE_ANSWER_QUESTION,
        band: ONE_ANSWER_UNSURE_BAND
      },
      'generic-one-answer-route@1': {
        method: 'noul',
        question: ONE_ANSWER_QUESTION,
        band: ONE_ANSWER_UNSURE_BAND
      },
      'discover-verify@1': verify,
      'generic-finding-verify@1': verify,
      'discover-verify@2': verify,
      'generic-finding-verify@2': verify,
      'discover-verify@3': verify,
      'generic-finding-verify@3': verify
    }
    expect(
      Object.fromEntries(DECISION_CONTRACTS.map((c) => [contractRefOf(c), c.confidence]))
    ).toEqual(expected)
  })

  it('changes only how an unscored option is read in find-screen@2', () => {
    for (const id of ['find-screen', 'generic-screen-order']) {
      const [one, two] = [contractByRef(`${id}@1`), contractByRef(`${id}@2`)]
      const { gates: _g1, unknown: _u1, version: _v1, ...sameOne } = one
      const { gates: _g2, unknown: _u2, version: _v2, ...sameTwo } = two
      expect(sameTwo).toEqual(sameOne)
      expect(two.gates.slice(0, 2)).toEqual(one.gates.slice(0, 2))
      expect(two.unknown).toEqual({ when: ['unscored'], fallback: 'keep-and-verify' })
    }
  })

  it('keeps the fallbacks today applies when JEV is unsure', () => {
    const fallback = (ref: string) => contractByRef(ref).unknown.fallback
    expect(fallback('discover-set-aside@1')).toBe('keep-and-verify')
    expect(fallback('decide-shortlist@1')).toBe('keep-and-verify')
    expect(fallback('improve-judge@1')).toBe('keep-incumbent')
    expect(fallback('council-final-check@1')).toBe('keep-chair')
    expect(fallback('decide-final-check@1')).toBe('keep-chair')
    expect(fallback('decide-one-answer@1')).toBe('full-workflow')
    expect(fallback('decide-compare-line@1')).toBe('gap')
    expect(fallback('council-peer-rank@1')).toBe('models-decide')
  })
})

describe('the library', () => {
  it('never lets a published version change: the digest table holds', () => {
    const actual = Object.fromEntries(
      DECISION_CONTRACTS.map((c) => [contractRefOf(c), digestOf(c)])
    )
    // A changed digest means a new version is due (@N+1), never an edit in place.
    expect(actual).toEqual(digests)
  })

  it('never reads an unknown judgement as a low score', () => {
    for (const contract of DECISION_CONTRACTS) {
      expect(UNKNOWN_OUTCOMES).toContain(contract.unknown.fallback)
      expect(contract.unknown.fallback).not.toMatch(/\b(?:low|drop|reject|set-aside|fail)/)
      if (contract.kind === 'set-aside-gate' || contract.kind === 'hard-limit-gate') {
        expect(contract.unknown.when).toEqual(expect.arrayContaining(['jev-failed', 'unscored']))
        expect(contract.unknown.fallback).toBe('keep-and-verify')
      }
      // From @2 a screen keeps and checks an option it could not score, never drops it as low.
      if (contract.kind === 'screen-order' && contract.version >= 2) {
        expect(contract.unknown.when).toContain('unscored')
        expect(contract.unknown.fallback).toBe('keep-and-verify')
      }
    }
  })

  it('refuses a ref it does not know', () => {
    expect(() => contractByRef('council-peer-rank@2')).toThrow(/Unknown decision contract/)
    expect(() => contractByRef('council-peer-rank')).toThrow(/Unknown decision contract/)
    expect(() => contractByRef('no-such-contract@1')).toThrow(/Unknown decision contract/)
  })

  it('publishes each ref once, and every table names a contract of the right kind', () => {
    const refs = DECISION_CONTRACTS.map(contractRefOf)
    expect(new Set(refs).size).toBe(refs.length)
    for (const kind of DECISION_KINDS) {
      expect(contractByRef(GENERIC_CONTRACTS[kind]).kind).toBe(kind)
    }
    for (const table of [DEFAULT_CONTRACTS, LEGACY_CONTRACTS.byTemplate]) {
      for (const kinds of Object.values(table)) {
        for (const [kind, ref] of Object.entries(kinds)) {
          expect(contractByRef(ref).kind).toBe(kind)
        }
      }
    }
  })

  it('pins the legacy table to version 1', () => {
    const legacy = [
      ...Object.values(LEGACY_CONTRACTS.byTemplate).flatMap((kinds) => Object.values(kinds)),
      ...Object.values(LEGACY_CONTRACTS.generic)
    ]
    expect(legacy.length).toBeGreaterThan(0)
    expect(legacy.every((ref) => ref.endsWith('@1'))).toBe(true)
  })
})
