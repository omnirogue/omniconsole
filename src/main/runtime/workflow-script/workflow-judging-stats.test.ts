import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DECISION_EXPERIMENT_TARIFF } from '../../structured-decisions/decision-experiment-metrics'
import { workflowJudgingStats } from './workflow-judging-stats'
import { WORKFLOW_JUDGING_FILE } from './workflow-judging-stats-read'

const candidate = (label: string, route: string, won: boolean, extra: object = {}) => ({
  label,
  route,
  model: `${route}-model`,
  systemDigest: `sys-${route}`,
  place: won ? 1 : 2,
  votes: 1,
  won,
  ...extra
})

/** An older Rank line: no kind, no contract, no method, no tokens, no time. */
const OLD = {
  at: 1_000,
  executionId: 'run-old',
  template: 'council',
  stepId: 'rank',
  round: 1,
  taskDigest: 't',
  taskPreview: 'Question',
  rubricDigest: 'rubric-old',
  candidates: [candidate('A', 'claude', true), candidate('B', 'codex', false)],
  jev: { ranking: ['A', 'B'], unsure: false, counted: true },
  models: []
}

const NEW = {
  kind: 'rank',
  at: 2_000,
  executionId: 'run-new',
  template: 'council',
  stepId: 'rank',
  round: 1,
  taskDigest: 't',
  taskPreview: 'Question',
  rubricDigest: 'rubric-old',
  jevRubricDigest: 'rubric-jev',
  contract: 'council-rank@1',
  candidates: [candidate('A', 'claude', false), candidate('B', 'codex', true)],
  jev: {
    ranking: ['A', 'B'],
    unsure: true,
    counted: true,
    method: 'pairwise',
    usage: { inputTokens: 2_000, outputTokens: 100 },
    unsureReason: 'close',
    durationMs: 500
  },
  models: [{ route: 'grok', model: 'grok-model', ranking: ['B', 'A'] }],
  agreement: { topSame: false, pairs: 0 }
}

/** Improve: the incumbent held its place; JEV was asked and failed, so the models decided. */
const DEFENCE = {
  kind: 'rank',
  at: 3_000,
  executionId: 'run-new',
  template: 'improve',
  stepId: 'judge',
  round: 3,
  taskDigest: 't',
  taskPreview: 'Question',
  rubricDigest: 'r',
  jevRubricDigest: 'r-jev',
  contract: 'improve-judge@1',
  candidates: [
    candidate('A', 'claude', true, { incumbent: true }),
    candidate('B', 'codex', false),
    candidate('C', 'grok', false)
  ],
  jevFailed: true,
  models: [
    { route: 'claude', ranking: ['A', 'B', 'C'] },
    { route: 'codex', ranking: ['A', 'C', 'B'] }
  ]
}

const GATE = {
  kind: 'gate',
  at: 2_500,
  executionId: 'run-new',
  template: 'discover',
  stepId: 'verify',
  round: 1,
  gate: 'set-aside',
  callId: 'verify/screen',
  taskDigest: 't',
  contract: 'discover-set-aside@1',
  decision: 'screened',
  counts: { items: 6, scored: 5, setAside: 2 },
  jev: { status: 'done', usage: { inputTokens: 600, outputTokens: 0 }, durationMs: 100 }
}

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

function record(lines: unknown[], torn = '') {
  dir = mkdtempSync(join(tmpdir(), 'judging-stats-'))
  writeFileSync(
    join(dir, WORKFLOW_JUDGING_FILE),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n${torn}`
  )
  return dir
}

function ballots(executionId: string, records: Record<string, unknown>) {
  mkdirSync(join(dir, executionId), { recursive: true })
  writeFileSync(join(dir, executionId, 'jev-ballots.json'), JSON.stringify(records))
}

describe('workflow judging stats', () => {
  it('skips a torn last line and repeats, and says so', async () => {
    const root = record([OLD, OLD, NEW, GATE, GATE], '{"kind":"rank","at":9,"exec')
    const stats = await workflowJudgingStats({}, root)
    expect(stats.note).toBe("Wins are the judges' view of the answers, not real results.")
    expect(stats.source).toEqual({
      file: join(root, WORKFLOW_JUDGING_FILE),
      lines: 6,
      skipped: 1,
      duplicates: 2,
      matched: 3,
      joined: 0
    })
    expect(stats.groups.map((group) => group.rounds)).toEqual([1, 1])
    expect(stats.gates).toHaveLength(1)
    expect(stats.gates[0]!.count).toBe(1)
  })

  it('reads an empty record from a missing file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'judging-stats-'))
    const stats = await workflowJudgingStats({}, dir)
    expect(stats.groups).toEqual([])
    expect(stats.source.lines).toBe(0)
  })

  it('joins an older line’s JEV method and tokens from its run’s ballots, and never invents them', async () => {
    const root = record([OLD, { ...OLD, executionId: 'run-none', round: 2 }])
    ballots('run-old', {
      'rank/jev': {
        digest: 'd',
        at: 1,
        outcome: {
          value: {
            markdown: 'ballot',
            judgment: { method: 'rubric', usage: { inputTokens: 300, outputTokens: 30 } }
          }
        }
      }
    })
    const stats = await workflowJudgingStats({}, root)
    expect(stats.source.joined).toBe(1)
    const [group] = stats.groups
    expect(group!.rounds).toBe(2)
    expect(group!.jevTokens).toEqual({ input: 300, output: 30, rounds: 1 })
    expect(group!.jevUsd).toBe(
      Math.round(300 * DECISION_EXPERIMENT_TARIFF.inputUsdPerMillion) / 1_000_000
    )
    expect(group!.jevMs).toBe('unknown')
    expect(group!.agreement).toBe('unknown')
  })

  it('says unknown, never 0, for what the record lacks', async () => {
    const modelsOnly = { ...OLD, executionId: 'run-models', jev: undefined, models: NEW.models }
    const stats = await workflowJudgingStats({}, record([modelsOnly, OLD]))
    const byJudges = Object.fromEntries(stats.groups.map((group) => [group.judgedBy, group]))
    expect(byJudges.models!.jev.failed).toBe('unknown')
    expect(byJudges.models!.jevTokens).toBe('unknown')
    expect(byJudges.models!.jevUsd).toBe('unknown')
    expect(byJudges.models!.jevMs).toBe('unknown')
    expect(byJudges.jev!.jev.failed).toBe(0)
    expect(JSON.stringify(stats)).not.toContain('"jevUsd":0')
  })

  it('groups rounds by template, step, decision and judges; lists seats and gates apart', async () => {
    const stats = await workflowJudgingStats({}, record([OLD, NEW, DEFENCE, GATE]))
    expect(
      stats.groups.map((group) => [group.template, group.stepId, group.decision, group.judgedBy])
    ).toEqual([
      ['council', 'rank', { contract: 'council-rank@1' }, 'jev and models'],
      ['council', 'rank', { rubricDigest: 'rubric-old' }, 'jev'],
      ['improve', 'judge', { contract: 'improve-judge@1' }, 'models']
    ])
    const [escalated, alone, defended] = stats.groups
    expect(escalated).toMatchObject({
      rounds: 1,
      wins: { codex: 1 },
      defences: 0,
      jev: { alone: 0, escalated: 1, failed: 0, countedWhileUnsure: 1 },
      agreement: { rounds: 1, topSame: 0 },
      jevTokens: { input: 2_000, output: 100, rounds: 1 },
      modelJudgeCalls: 1,
      jevMs: { total: 500, rounds: 1 },
      first: 2_000,
      last: 2_000
    })
    expect(alone).toMatchObject({
      wins: { claude: 1 },
      jev: { alone: 1, escalated: 0, failed: 0, countedWhileUnsure: 0 },
      jevTokens: 'unknown'
    })
    expect(defended).toMatchObject({
      wins: {},
      defences: 1,
      jev: { alone: 0, escalated: 0, failed: 1, countedWhileUnsure: 0 },
      modelJudgeCalls: 2
    })
    // Most wins first, then most rounds entered: a defence is never a win for the seat.
    expect(stats.seats).toEqual([
      {
        route: 'codex',
        model: 'codex-model',
        systemDigest: 'sys-codex',
        entered: 3,
        wins: 1,
        defences: 0
      },
      {
        route: 'claude',
        model: 'claude-model',
        systemDigest: 'sys-claude',
        entered: 2,
        wins: 1,
        defences: 1
      },
      {
        route: 'grok',
        model: 'grok-model',
        systemDigest: 'sys-grok',
        entered: 1,
        wins: 0,
        defences: 0
      }
    ])
    expect(stats.gates).toEqual([
      {
        template: 'discover',
        stepId: 'verify',
        gate: 'set-aside',
        contract: 'discover-set-aside@1',
        count: 1,
        decisions: { screened: 1 },
        jevFailed: 0,
        jevTokens: { input: 600, output: 0, rounds: 1 },
        jevUsd: Math.round(600 * DECISION_EXPERIMENT_TARIFF.inputUsdPerMillion) / 1_000_000,
        jevMs: { total: 100, rounds: 1 }
      }
    ])
    expect(stats.tariff.model).toBe(DECISION_EXPERIMENT_TARIFF.model)
  })

  it('counts the items live JEV verify confirmed, apart from shadow verify', async () => {
    const verify = (round: number, contract: string, decision: string, confirmed?: number) => ({
      ...GATE,
      round,
      gate: 'verify',
      callId: `verify/r${round}/jev-verify`,
      contract,
      decision,
      counts: { items: 4, scored: 4, ...(confirmed === undefined ? {} : { confirmed }) }
    })
    const stats = await workflowJudgingStats(
      {},
      record([
        verify(1, 'discover-verify@2', 'confirmed', 2),
        verify(2, 'discover-verify@2', 'none confirmed', 0),
        verify(3, 'discover-verify@1', 'recorded')
      ])
    )
    const row = (contract: string) => stats.gates.find((gate) => gate.contract === contract)!
    expect(row('discover-verify@2')).toMatchObject({
      count: 2,
      decisions: { confirmed: 1, 'none confirmed': 1 },
      jevConfirmed: 2
    })
    expect(row('discover-verify@1').jevConfirmed).toBeUndefined()
    expect(row('discover-verify@2').jevRefuted).toBeUndefined()
  })

  it('counts the items live JEV verify set aside, apart from its confirmations', async () => {
    const verify = (round: number, decision: string, refuted: number, confirmed?: number) => ({
      ...GATE,
      round,
      gate: 'verify',
      callId: `verify/r${round}/jev-verify`,
      contract: 'discover-verify@3',
      decision,
      counts: { items: 4, scored: 4, refuted, ...(confirmed === undefined ? {} : { confirmed }) }
    })
    const stats = await workflowJudgingStats(
      {},
      record([verify(1, 'set aside', 3), verify(2, 'none set aside', 0), verify(3, 'set aside', 1)])
    )
    const row = stats.gates.find((gate) => gate.contract === 'discover-verify@3')!
    expect(row).toMatchObject({
      count: 3,
      decisions: { 'set aside': 2, 'none set aside': 1 },
      jevRefuted: 4
    })
    expect(row.jevConfirmed).toBeUndefined()
  })

  it('keeps only the template and time asked for', async () => {
    const root = record([OLD, NEW, DEFENCE, GATE])
    const council = await workflowJudgingStats({ template: 'council' }, root)
    expect(council.source.matched).toBe(2)
    expect(council.gates).toEqual([])
    const recent = await workflowJudgingStats({ since: 2_500 }, root)
    expect(recent.source.matched).toBe(2)
    expect(recent.groups.map((group) => group.template)).toEqual(['improve'])
    expect(recent.gates).toHaveLength(1)
  })
})
