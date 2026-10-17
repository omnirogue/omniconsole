import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { normalizeCommandPositionals, parseArgs, validateCommandAndFlags } from '../args'
import { ROOT_HELP_TEXT_PRIMARY } from '../root-help-text-primary'
import { COMMAND_SPECS } from '../specs'
import { LOCAL_WORKFLOW_METHODS } from '../../shared/local-workflow-rpc'
import type { WorkflowJudgingStats } from '../../shared/workflow-judging-stats'
import { statsRequestFromFlags, WORKFLOW_STATS_HANDLERS } from './workflow-stats'

const STATS: WorkflowJudgingStats = {
  note: "Wins are the judges' view of the answers, not real results.",
  source: {
    file: '/data/local-workflow-attempts/workflow-judging.jsonl',
    lines: 12,
    skipped: 1,
    duplicates: 2,
    matched: 9,
    joined: 3
  },
  tariff: { model: 'jev-1.13.0', inputUsdPerMillion: 0.042, outputUsdPerMillion: 0 },
  groups: [
    {
      template: 'council',
      stepId: 'rank',
      decision: { contract: 'council-rank@1' },
      judgedBy: 'jev and models',
      rounds: 6,
      wins: { claude: 3, codex: 2 },
      defences: 1,
      jev: { alone: 2, escalated: 4, failed: 0, countedWhileUnsure: 1 },
      agreement: { rounds: 4, topSame: 3 },
      jevTokens: { input: 12_000, output: 300, rounds: 5 },
      jevUsd: 0.000504,
      modelJudgeCalls: 8,
      jevMs: { total: 12_300, rounds: 5 },
      first: Date.UTC(2026, 8, 20, 10),
      last: Date.UTC(2026, 8, 24, 9)
    },
    {
      template: 'improve',
      stepId: 'judge',
      decision: { rubricDigest: 'abcd1234abcd1234' },
      judgedBy: 'models',
      rounds: 2,
      wins: {},
      defences: 2,
      jev: { alone: 0, escalated: 0, failed: 'unknown', countedWhileUnsure: 0 },
      agreement: 'unknown',
      jevTokens: 'unknown',
      jevUsd: 'unknown',
      modelJudgeCalls: 4,
      jevMs: 'unknown',
      first: Date.UTC(2026, 8, 21),
      last: Date.UTC(2026, 8, 21)
    }
  ],
  seats: [
    { route: 'claude', model: 'opus', systemDigest: 'sys1', entered: 6, wins: 3, defences: 1 },
    { route: 'codex', model: 'unknown', systemDigest: 'unknown', entered: 6, wins: 2, defences: 0 }
  ],
  gates: [
    {
      template: 'discover',
      stepId: 'verify',
      gate: 'set-aside',
      contract: 'discover-set-aside@1',
      count: 4,
      decisions: { screened: 3, 'not screened': 1 },
      jevFailed: 1,
      jevTokens: { input: 2_400, output: 0, rounds: 3 },
      jevUsd: 0.000101,
      jevMs: 'unknown'
    }
  ]
}

function parse(argv: string[]) {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(
      argv,
      COMMAND_SPECS.map((spec) => spec.path)
    )
  )
  validateCommandAndFlags(COMMAND_SPECS, parsed)
  return parsed
}

function run(argv: string[], json = false) {
  const call = vi.fn(async () => ({ result: STATS }))
  const parsed = parse(argv)
  const done = WORKFLOW_STATS_HANDLERS[parsed.commandPath.join(' ')]!({
    client: { call, isRemote: false },
    flags: parsed.flags,
    cwd: '/work',
    json
  } as unknown as HandlerContext)
  return { call, done }
}

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('omni workflow stats', () => {
  it('73: merges exports without contacting a runtime and rejects a missing sample size', async () => {
    const root = mkdtempSync(join(tmpdir(), 'discover-export-'))
    try {
      const file = join(root, 'host.json')
      writeFileSync(file, JSON.stringify({ version: 1, runs: [], unreadable: 0 }))
      const { done, call } = run(['workflow', 'stats', '--merge', `${file},${file}`, '--export'])
      await done
      expect(call).not.toHaveBeenCalled()
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ version: 1, runs: [], unreadable: 0 })
      await expect(run(['workflow', 'stats', '--blind-review', '0']).done).rejects.toThrow(
        'sample count'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads its flags, and names a mistake before the app is asked', () => {
    expect(statsRequestFromFlags(parse(['workflow', 'stats']).flags)).toEqual({})
    expect(
      statsRequestFromFlags(
        parse(['workflow', 'stats', '--template', 'council', '--since', '2026-09-20']).flags
      )
    ).toEqual({ template: 'council', since: Date.UTC(2026, 8, 20) })
    expect(() =>
      statsRequestFromFlags(parse(['workflow', 'stats', '--since', 'yesterday']).flags)
    ).toThrow('--since: yesterday is not a date')
    expect(() => statsRequestFromFlags(parse(['workflow', 'stats', '--template']).flags)).toThrow(
      '--template needs a template name.'
    )
    expect(ROOT_HELP_TEXT_PRIMARY).toContain('  workflow stats ')
  })

  it('asks the app for the stats and prints them in plain words, the warning first', async () => {
    const { call, done } = run(['workflow', 'stats', '--template', 'council'])
    await done
    expect(call).toHaveBeenCalledWith(LOCAL_WORKFLOW_METHODS.stats, { template: 'council' })
    const text = String(log.mock.calls[0]![0])
    expect(text.split('\n')[0]).toBe("Wins are the judges' view of the answers, not real results.")
    expect(text).toContain(
      "12 lines read from /data/local-workflow-attempts/workflow-judging.jsonl; 9 kept; 1 could not be read; 2 repeated; 3 older lines filled in from the run's ballots."
    )
    expect(text).toContain(
      'council · rank · judged by JEV and the model judges · contract council-rank@1'
    )
    expect(text).toContain('Rounds: 6. Wins: claude 3, codex 2. Incumbent defences: 1.')
    expect(text).toContain('JEV alone 2, escalated 4, failed 0, counted while unsure 1.')
    expect(text).toContain(
      'Top agreement (hard rounds only): JEV and the models put the same answer first in 3 of 4 hard rounds.'
    )
    expect(text).toContain(
      'JEV tokens: 12,000 in, 300 out over 5 of 6. JEV cost: $0.0005. JEV time: 12.3 s over 5 of 6. Model judge calls: 8.'
    )
    expect(text).toContain('First 2026-09-20T10:00:00Z, last 2026-09-24T09:00:00Z.')
    expect(text).toContain('improve · judge · judged by the model judges · rubric abcd1234abcd1234')
    expect(text).toContain('Rounds: 2. Wins: none. Incumbent defences: 2.')
    expect(text).toContain('failed unknown')
    expect(text).toContain('Top agreement (hard rounds only): unknown.')
    expect(text).toContain('JEV tokens: unknown. JEV cost: unknown. JEV time: unknown.')
    expect(text).toContain('model family  model    system prompt  entered  wins  defences')
    expect(text).toContain('claude        opus     sys1           6        3     1')
    expect(text).toContain('codex         unknown  unknown        6        2     0')
    expect(text).toContain('discover · verify · set-aside · contract discover-set-aside@1')
    expect(text).toContain('Decided 4 times: screened 3, not screened 1. JEV failed 1.')
    expect(text).toContain(
      'JEV tokens: 2,400 in, 0 out over 3 of 4. JEV cost: $0.0001. JEV time: unknown.'
    )
    expect(text).not.toMatch(/\b0 unknown|unknown 0\b/)
  })

  it('prints the stats as JSON with --json, unchanged', async () => {
    const { done } = run(['workflow', 'stats', '--json'], true)
    await done
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual(STATS)
  })
})
