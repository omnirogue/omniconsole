import { describe, expect, it } from 'vitest'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowCallView } from '../../../shared/local-workflow-view'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  discoverResultMarkdown,
  discoverStageDefinitions,
  projectDiscoverEvidence,
  projectDiscoverRun,
  workflowCallSeatId
} from './local-workflow-discover-projection'
import { DISCOVER_V7_RULES, discoverV7ConfigFromSnapshot } from './presets/discover-v7-config'
import { createWorkflowProgramContext, type WorkflowProgramCall } from './workflow-program-context'
import { runDiscoverV7Program } from './presets/discover-v7'
import type { DiscoverV7RawFinding, DiscoverV7Vote } from './presets/discover-v7-plan'
import { selectDiscoverFindings, type FindingBatch } from './presets/discover-assessment'

function seat(
  id: string,
  agent: ResolvedLocalWorkflowSeat['agent'],
  lineage: ResolvedLocalWorkflowSeat['lineage'],
  model: string
): ResolvedLocalWorkflowSeat {
  return {
    id,
    agent,
    accountId: `${id}-account`,
    model,
    effort: null,
    lineage,
    policyRevision: 'fixture-v1'
  }
}
const host = {
  workspaceId: 'w',
  conversationId: 'c',
  requestDigest: 'digest',
  startedAt: 1,
  concurrency: 2,
  sources: [],
  coverage: [],
  discoverRules: DISCOVER_V7_RULES
}
const snapshot: LocalWorkflowHostSnapshot = {
  version: 1,
  discoverProgramRevision: 7,
  access: 'workspace-read',
  task: { prompt: 'Find real bugs in checkout', evidence: '' },
  seats: [
    seat('claude', 'claude', 'anthropic', 'claude-opus-5'),
    seat('codex', 'codex', 'openai', 'gpt-5.6-sol'),
    seat('grok', 'grok', 'xai', 'grok-4.6'),
    seat('gemini', 'gemini', 'google', 'gemini-3.8-flash')
  ],
  synthesizerId: 'claude',
  discover: {
    ...createLocalWorkflowDraft('discover').discover,
    finderIds: ['codex', 'grok', 'gemini'],
    lensIds: ['correctness', 'security'],
    depth: 'quick',
    focus: ['src'],
    maxAgents: 160
  },
  host
}
const areas = {
  areas: [
    { name: 'Checkout', files: ['src/a.ts'], why: 'Charges the card' },
    { name: 'Payments', files: ['src/b.ts'], why: 'Talks to the processor' }
  ]
}
function finding(file: string, line: number, title: string): DiscoverV7RawFinding {
  return {
    title,
    file,
    line,
    endLine: line + 2,
    severity: 'critical',
    trigger: 'Two tabs submit at once',
    scenario: 'The card is charged twice',
    evidence: 'No idempotency key',
    fix: 'Add an idempotency key'
  }
}
const vote = (verdict: DiscoverV7Vote['verdict']): DiscoverV7Vote => ({
  verdict,
  reason: `${verdict} after tracing`,
  evidence: 'src/a.ts:12',
  filesRead: ['src/a.ts']
})
function call(
  id: string,
  state: LocalWorkflowCallView['state'],
  attempt = 1
): LocalWorkflowCallView {
  return {
    id,
    stageId: id.split('/')[0],
    seatLabel: '',
    model: '',
    effort: null,
    state,
    attempt,
    attemptLimit: 3,
    transport: 'headless',
    stdout: '',
    stderr: '',
    outputTruncated: false
  }
}
const batch = (findings: DiscoverV7RawFinding[] = []) => ({ findings, omitted: 0 })
/** A repeat check's answer: the listed groups, every other id a defect of its own. */
const repeats = (ids: string[], ...merged: string[][]) => ({
  groups: [
    ...merged.map((findingIds) => ({ findingIds, rootCause: 'One missing guard' })),
    ...ids
      .filter((id) => !merged.flat().includes(id))
      .map((id) => ({ findingIds: [id], rootCause: 'Its own cause' }))
  ]
})

describe('Discover revision 7 projection', () => {
  it('shows a finding as soon as its finder lands and fills its votes in live', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/correctness', batch([finding('src/a.ts', 12, 'Double charge')])]
    ])
    const calls = [
      call('scout/map', 'completed'),
      call('find/r1/0/correctness', 'completed'),
      call('find/r1/0/security', 'running'),
      call('find/r1/1/correctness', 'queued')
    ]
    const early = projectDiscoverRun(snapshot, results, calls)!
    expect(early).toMatchObject({
      areas: areas.areas,
      lenses: ['correctness', 'security'],
      round: 1,
      maxRounds: 1,
      counts: { found: 1, duplicates: 0, verifying: 1, confirmed: 0, refuted: 0, unverified: 0 },
      dropped: []
    })
    expect(early.report).toBeUndefined()
    const [first] = early.findings
    expect(first).toMatchObject({
      id: 'r1-a0-correctness-0',
      title: 'Double charge',
      location: 'src/a.ts:12-14',
      severity: 'critical',
      lens: 'correctness',
      area: 'Checkout',
      round: 1,
      status: 'verifying',
      foundBy: { seatId: 'grok', agent: 'grok', modelLabel: 'Grok 4.6' }
    })
    expect(first.markdown).toContain('**Scenario:** The card is charged twice')
    expect(first.votes.map((entry) => [entry.lens, entry.seat.seatId, entry.state])).toEqual([
      ['correctness', 'codex', 'pending'],
      ['reachability', 'claude', 'pending'],
      ['reproduction', 'codex', 'pending']
    ])

    // Votes start once the round's last finder is in; one finding needs no repeat check.
    for (const job of ['0/security', '1/correctness', '1/security']) {
      results.set(`find/r1/${job}`, batch())
    }
    results.set('verify/r1-a0-correctness-0/correctness', vote('real'))
    results.set('verify/r1-a0-correctness-0/reachability', vote('real'))
    const voting = projectDiscoverRun(snapshot, results, [
      call('verify/r1-a0-correctness-0/reproduction', 'running')
    ])!
    expect(voting.findings[0].status).toBe('confirmed')
    expect(voting.findings[0].votes.map((entry) => [entry.state, entry.verdict])).toEqual([
      ['done', 'real'],
      ['done', 'real'],
      ['running', undefined]
    ])
  })

  it('shows later finders provisionally while an earlier finder is still running', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/security', batch([finding('src/b.ts', 3, 'Token leak')])]
    ])
    const run = projectDiscoverRun(snapshot, results, [call('find/r1/0/correctness', 'running')])!
    expect(run.findings.map((entry) => [entry.id, entry.status])).toEqual([
      ['r1-a0-security-0', 'verifying']
    ])
    expect(run.findings[0].votes.every((entry) => entry.state === 'pending')).toBe(true)
    expect(run.findings[0].foundBy.agent).toBe('gemini')
    expect(run.findings[0].votes.some((entry) => entry.seat.agent === 'gemini')).toBe(false)
  })

  it('counts a failed vote as unjudged, never as a refute, and mirrors duplicates', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/correctness', batch([finding('src/a.ts', 12, 'Double charge')])],
      ['find/r1/0/security', batch([finding('src/a.ts', 15, 'Double  charge')])],
      ['find/r1/1/correctness', batch()],
      ['find/r1/1/security', batch()],
      ['verify/r1-a0-correctness-0/correctness', vote('refuted')],
      ['verify/r1-a0-correctness-0/reproduction', vote('unjudged')]
    ])
    // A failed attempt with attempts left runs again, so the vote is still owed.
    const retrying = projectDiscoverRun(snapshot, results, [
      call('verify/r1-a0-correctness-0/reachability', 'failed', 1)
    ])!
    expect(retrying.findings[0].status).toBe('verifying')
    expect(retrying.findings[0].votes[1].state).toBe('pending')
    expect(retrying.report).toBeUndefined()
    const run = projectDiscoverRun(snapshot, results, [
      call('verify/r1-a0-correctness-0/reachability', 'failed', 3)
    ])!
    expect(run.findings.map((entry) => [entry.id, entry.status, entry.duplicateOf])).toEqual([
      ['r1-a0-correctness-0', 'unverified', undefined],
      ['r1-a0-security-0', 'unverified', 'r1-a0-correctness-0']
    ])
    expect(run.findings[0].votes[1].state).toBe('failed')
    expect(run.findings[1].votes).toEqual([])
    expect(run.counts).toEqual({
      found: 2,
      duplicates: 1,
      verifying: 0,
      confirmed: 0,
      refuted: 0,
      unverified: 1
    })
    expect(run.report?.items).toEqual([])
    expect(run.report?.summary).toMatch(/No defect was confirmed/)
  })

  it('agrees with the program on every seat, status and the final report', async () => {
    const calls: WorkflowProgramCall[] = []
    const results = new Map<string, unknown>()
    const context = createWorkflowProgramContext({
      guard: () => {},
      isFatal: () => false,
      phase: () => {},
      log: () => {},
      agent: async (request) => {
        calls.push(request)
        const value = request.id.startsWith('scout/')
          ? areas
          : request.id === 'find/r1/repeats'
            ? repeats([...request.prompt.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]))
            : request.id === 'find/r1/0/correctness'
              ? batch([finding('src/a.ts', 12, 'Double charge'), finding('src/a.ts', 60, 'Race')])
              : request.id === 'find/r1/1/security'
                ? batch([finding('src/c.ts', 9, 'Stale total')])
                : request.id.startsWith('find/')
                  ? batch()
                  : request.id.startsWith('verify/r1-a0-correctness-1/')
                    ? vote('refuted')
                    : request.id.startsWith('verify/')
                      ? vote('real')
                      : {
                          summary: 'Fix the double charge first.',
                          items: [
                            {
                              rank: 2,
                              title: 'Stale total',
                              location: 'src/c.ts:9',
                              severity: 'medium',
                              scenario: 'Total lags one item',
                              fix: 'Recompute',
                              findingIds: ['r1-a1-security-0'],
                              parallelSafe: true
                            },
                            {
                              rank: 1,
                              title: 'Double charge',
                              location: 'src/a.ts:12',
                              severity: 'critical',
                              scenario: 'Charged twice',
                              fix: 'Idempotency key',
                              findingIds: ['r1-a0-correctness-0'],
                              parallelSafe: false
                            }
                          ],
                          refutedIds: ['r1-a0-correctness-1'],
                          unverifiedIds: []
                        }
        results.set(request.id, value)
        return value
      }
    })
    const program = await runDiscoverV7Program(
      context,
      discoverV7ConfigFromSnapshot(snapshot),
      snapshot.task
    )
    for (const request of calls) {
      expect(workflowCallSeatId(snapshot, request.id)).toBe(request.seatId)
    }
    const run = projectDiscoverRun(
      snapshot,
      results,
      calls.map((request) => call(request.id, 'completed'))
    )!
    expect(run.findings.map((entry) => [entry.id, entry.status])).toEqual(
      program.findings.map((entry) => [entry.id, entry.status])
    )
    expect(run.report?.items.map((item) => item.rank)).toEqual([1, 2])
    // The count line is written in code from the verdicts, the same in the program and the view.
    expect(run.report?.summary).toBe(program.report.summary)
    expect(program.report.summary).toBe(
      '2 confirmed findings in 2 ranked items; 1 refuted, 0 unverified.\n\nFix the double charge first.'
    )
    expect(run.dropped).toEqual(program.dropped)
    const markdown = discoverResultMarkdown(snapshot, results)!
    expect(markdown).toContain('# Discover report')
    expect(markdown).toContain('Fix the double charge first.')
    expect(markdown.indexOf('### 1. Double charge')).toBeLessThan(
      markdown.indexOf('### 2. Stale total')
    )
    expect(markdown).toContain('**Critical** · `src/a.ts:12` · Must be sequenced')
    expect(markdown).toContain('## Refuted\n\n- `r1-a0-correctness-1` Race (`src/a.ts:60-62`)')
    // Two findings in src/a.ts: the round's repeat check is the fifth call of Find.
    expect(calls.find((request) => request.id === 'find/r1/repeats')?.seatId).toBe('claude')
    expect(discoverStageDefinitions(snapshot, results, undefined)).toEqual([
      { id: 'scout', label: 'Scout', total: 1, summary: 'Map the code into areas' },
      { id: 'find', label: 'Find', total: 5, summary: 'Round 1 of 1' },
      { id: 'verify', label: 'Verify', total: 9, summary: 'Three independent votes per finding' },
      { id: 'rank', label: 'Rank', total: 1, summary: 'Merge and rank what is real' }
    ])
    expect(projectDiscoverEvidence(snapshot, results, true)).toEqual({})
  })

  it('writes the empty report in code when nothing was found', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ...['0/correctness', '0/security', '1/correctness', '1/security'].map(
        (job) => [`find/r1/${job}`, batch()] as [string, unknown]
      )
    ])
    expect(projectDiscoverRun(snapshot, results, [])!.report).toEqual({
      summary: 'Discover found no defects in the areas it inspected.',
      items: []
    })
    expect(discoverResultMarkdown(snapshot, results)).toBe(
      '# Discover report\n\nDiscover found no defects in the areas it inspected.'
    )
    expect(discoverStageDefinitions(snapshot, results, undefined).at(-1)).toMatchObject({
      id: 'rank',
      total: 0
    })
  })

  it('shows no report for a run stopped during Find', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/correctness', batch()]
    ])
    const stopped = ['find/r1/0/security', 'find/r1/1/correctness', 'find/r1/1/security'].map(
      (id) => call(id, 'cancelled')
    )
    const run = projectDiscoverRun(snapshot, results, stopped)!
    expect(run.report).toBeUndefined()
    expect(run.counts.found).toBe(0)
    expect(discoverStageDefinitions(snapshot, results, undefined, stopped).at(-1)).toMatchObject({
      id: 'rank',
      total: 1
    })
  })

  it('shows the unfinished votes of a stopped run as unverified, never verifying', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      [
        'find/r1/0/correctness',
        batch([finding('src/a.ts', 12, 'Double charge'), finding('src/a.ts', 60, 'Race')])
      ],
      ['find/r1/0/security', batch([finding('src/a.ts', 15, 'Double  charge')])],
      ['find/r1/1/correctness', batch()],
      ['find/r1/1/security', batch()],
      ['find/r1/repeats', repeats(['r1-a0-correctness-0', 'r1-a0-correctness-1'])],
      ['verify/r1-a0-correctness-0/correctness', vote('real')]
    ])
    // Stop cut one vote off at its first attempt; the Race votes never started.
    const calls = [
      call('verify/r1-a0-correctness-0/reachability', 'cancelled', 1),
      call('verify/r1-a0-correctness-0/reproduction', 'running')
    ]
    const live = projectDiscoverRun(snapshot, results, calls)!
    expect(live.findings.map((entry) => entry.status)).toEqual([
      'verifying',
      'verifying',
      'verifying'
    ])
    expect(live.counts.verifying).toBe(2)
    expect(live.findings[0].votes.map((entry) => entry.state)).toEqual([
      'done',
      'pending',
      'running'
    ])
    const stopped = projectDiscoverRun(snapshot, results, calls, true)!
    expect(stopped.findings.map((entry) => [entry.id, entry.status, entry.duplicateOf])).toEqual([
      ['r1-a0-correctness-0', 'unverified', undefined],
      ['r1-a0-correctness-1', 'unverified', undefined],
      ['r1-a0-security-0', 'unverified', 'r1-a0-correctness-0']
    ])
    // The vote that landed keeps its verdict; the rest show as never landing, not as waiting.
    expect(stopped.findings[0].votes.map((entry) => [entry.state, entry.verdict])).toEqual([
      ['done', 'real'],
      ['failed', undefined],
      ['failed', undefined]
    ])
    expect(stopped.findings[1].votes.map((entry) => entry.state)).toEqual([
      'failed',
      'failed',
      'failed'
    ])
    expect(stopped.counts).toEqual({
      found: 3,
      duplicates: 1,
      verifying: 0,
      confirmed: 0,
      refuted: 0,
      unverified: 2
    })
    // Settling the status never makes a stopped search look finished.
    expect(stopped.report).toBeUndefined()
    expect(stopped.round).toBe(live.round)
  })

  it('keeps decided findings of a stopped run as they were', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/correctness', batch([finding('src/a.ts', 12, 'Double charge')])],
      ...['0/security', '1/correctness', '1/security'].map(
        (job) => [`find/r1/${job}`, batch()] as [string, unknown]
      ),
      ['verify/r1-a0-correctness-0/correctness', vote('refuted')],
      ['verify/r1-a0-correctness-0/reachability', vote('refuted')]
    ])
    const run = projectDiscoverRun(snapshot, results, [], true)!
    expect(run.findings.map((entry) => entry.status)).toEqual(['refuted'])
    expect(run.findings[0].votes.map((entry) => [entry.state, entry.verdict])).toEqual([
      ['done', 'refuted'],
      ['done', 'refuted'],
      ['failed', undefined]
    ])
    expect(run.counts).toMatchObject({ verifying: 0, refuted: 1, unverified: 0 })
  })

  it('reports a finder whose attempts ran out and settles the stage totals', () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/correctness', batch()],
      ['find/r1/0/security', batch()],
      ['find/r1/1/correctness', batch()]
    ])
    const calls = [call('find/r1/1/security', 'failed', 3)]
    expect(projectDiscoverRun(snapshot, results, calls)!.report?.summary).toBe(
      'Discover found no defects in the areas it inspected. 1 of 4 finder jobs returned nothing, so part of the code was not searched.'
    )
    expect(
      discoverStageDefinitions(snapshot, results, undefined, calls).map((stage) => stage.total)
    ).toEqual([1, 4, 0, 0])
    // Without call states the missing result still counts as owed.
    expect(discoverStageDefinitions(snapshot, results, undefined).at(-1)?.total).toBe(1)
  })

  it('shows the next round while the votes of the last one are still out', () => {
    const thorough = {
      ...snapshot,
      discover: { ...snapshot.discover!, depth: 'thorough' as const }
    }
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/correctness', batch([finding('src/a.ts', 12, 'Double charge')])],
      ...['0/security', '1/correctness', '1/security'].map(
        (job) => [`find/r1/${job}`, batch()] as [string, unknown]
      ),
      ['find/r2/0/correctness', batch([finding('src/b.ts', 40, 'Token leak')])]
    ])
    const run = projectDiscoverRun(thorough, results, [])!
    expect(run.round).toBe(2)
    expect(run.findings.map((entry) => [entry.id, entry.status])).toEqual([
      ['r1-a0-correctness-0', 'verifying'],
      ['r2-a0-correctness-0', 'verifying']
    ])
    expect(discoverStageDefinitions(thorough, results, undefined)[1]).toMatchObject({
      total: 8,
      summary: 'Round 2 of 3'
    })
  })

  it('keeps each verified report on its own outcome and a repeat on its original, as the program does', () => {
    // The repeat at 22 matches the original at 10; the report at 34 only resembles the repeat.
    const copy = (line: number) => batch([finding('src/a.ts', line, 'Double charge on retry')])
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      ['find/r1/0/correctness', copy(10)],
      ['find/r1/0/security', copy(22)],
      ['find/r1/1/correctness', copy(34)],
      ['find/r1/1/security', batch()],
      ['find/r1/repeats', repeats(['r1-a0-correctness-0', 'r1-a1-correctness-0'])]
    ])
    for (const lens of ['correctness', 'reachability', 'reproduction']) {
      results.set(`verify/r1-a0-correctness-0/${lens}`, vote('real'))
      results.set(`verify/r1-a1-correctness-0/${lens}`, vote('refuted'))
    }
    results.set('rank/final', {
      summary: 'Fix the double charge.',
      items: [
        {
          rank: 1,
          title: 'Double charge',
          location: 'src/a.ts:10',
          severity: 'critical',
          scenario: 'Charged twice',
          fix: 'Idempotency key',
          findingIds: ['r1-a0-correctness-0'],
          parallelSafe: true
        }
      ],
      refutedIds: [],
      unverifiedIds: []
    })
    const run = projectDiscoverRun(snapshot, results, [])!
    expect(run.findings.map((entry) => [entry.id, entry.status, entry.duplicateOf])).toEqual([
      ['r1-a0-correctness-0', 'confirmed', undefined],
      ['r1-a0-security-0', 'confirmed', 'r1-a0-correctness-0'],
      ['r1-a1-correctness-0', 'refuted', undefined]
    ])
    expect(run.findings[1].votes).toEqual([])
    expect(run.counts).toMatchObject({ found: 3, duplicates: 1, confirmed: 1, refuted: 1 })
    expect(discoverResultMarkdown(snapshot, results)).toContain(
      '## Refuted\n\n- `r1-a1-correctness-0` Double charge on retry (`src/a.ts:34-36`)'
    )
  })

  it("holds a round's findings until its repeat check answers, then replays the merge it journaled", () => {
    const results = new Map<string, unknown>([
      ['scout/map', areas],
      [
        'find/r1/0/correctness',
        batch([finding('src/a.ts', 9, 'Loop starts at the excluded slot')])
      ],
      ['find/r1/0/security', batch([finding('src/a.ts', 15, 'Slot count is reserved itself')])],
      ['find/r1/1/correctness', batch([finding('src/b.ts', 3, 'Token leak')])],
      ['find/r1/1/security', batch()]
    ])
    const checking = [call('find/r1/repeats', 'running')]
    const waiting = projectDiscoverRun(snapshot, results, checking)!
    expect(waiting.findings.map((entry) => [entry.id, entry.status])).toEqual([
      ['r1-a0-correctness-0', 'verifying'],
      ['r1-a0-security-0', 'verifying'],
      ['r1-a1-correctness-0', 'verifying']
    ])
    // No vote is planned, let alone running, before the check answers.
    expect(waiting.findings.flatMap((entry) => entry.votes.map((vote) => vote.state))).toEqual(
      Array(9).fill('pending')
    )
    expect(
      discoverStageDefinitions(snapshot, results, undefined, checking).map((stage) => stage.total)
    ).toEqual([1, 5, 0, 1])
    results.set(
      'find/r1/repeats',
      repeats(
        ['r1-a0-correctness-0', 'r1-a0-security-0', 'r1-a1-correctness-0'],
        ['r1-a0-security-0', 'r1-a0-correctness-0']
      )
    )
    const merged = projectDiscoverRun(snapshot, results, [])!
    expect(merged.findings.map((entry) => [entry.id, entry.duplicateOf])).toEqual([
      ['r1-a0-correctness-0', undefined],
      ['r1-a0-security-0', 'r1-a0-correctness-0'],
      ['r1-a1-correctness-0', undefined]
    ])
    expect(merged.findings[1].votes).toEqual([])
    expect(merged.counts).toMatchObject({ found: 3, duplicates: 1, verifying: 2 })
    expect(discoverStageDefinitions(snapshot, results, undefined)[2].total).toBe(6)
    // A check whose attempts ran out merges nothing: every finding gets its votes.
    results.delete('find/r1/repeats')
    const failed = projectDiscoverRun(snapshot, results, [call('find/r1/repeats', 'failed', 3)])!
    expect(failed.findings.some((entry) => entry.duplicateOf)).toBe(false)
    expect(failed.findings.every((entry) => entry.votes.length === 3)).toBe(true)
  })

  it('routes finder jobs and votes as the program does around a seat frozen as serialized', async () => {
    const serialized: LocalWorkflowHostSnapshot = {
      ...snapshot,
      host: { ...host, serializedSeats: ['codex'] }
    }
    const three = {
      areas: [...areas.areas, { name: 'Refunds', files: ['src/c.ts'], why: 'Returns money' }]
    }
    const calls: WorkflowProgramCall[] = []
    const context = createWorkflowProgramContext({
      guard: () => {},
      isFatal: () => false,
      phase: () => {},
      log: () => {},
      agent: async (request) => {
        calls.push(request)
        return request.id === 'scout/map'
          ? three
          : request.id === 'find/r1/0/correctness'
            ? batch([finding('src/a.ts', 12, 'Double charge')])
            : request.id === 'find/r1/1/security'
              ? batch([finding('src/c.ts', 9, 'Stale total')])
              : request.id.startsWith('find/')
                ? batch()
                : vote('refuted')
      }
    })
    await runDiscoverV7Program(context, discoverV7ConfigFromSnapshot(serialized), serialized.task)
    const votes = calls.filter((request) => request.id.startsWith('verify/'))
    expect(votes).toHaveLength(6)
    expect(votes.some((request) => request.seatId === 'codex')).toBe(false)
    // The plain rotation gives Codex two of the six jobs; it keeps its first and hands on the other.
    const finds = calls.filter((request) => /^find\/r1\/\d+\//.test(request.id))
    expect(
      finds.filter((request) => request.seatId === 'codex').map((request) => request.id)
    ).toEqual(['find/r1/1/security'])
    expect(finds.find((request) => request.id === 'find/r1/2/correctness')?.seatId).toBe('gemini')
    for (const request of calls) {
      expect(workflowCallSeatId(serialized, request.id)).toBe(request.seatId)
    }
    // Without the hint that job is Codex's.
    expect(workflowCallSeatId(snapshot, 'find/r1/2/correctness')).toBe('codex')
  })

  it("replays the votes a round hands to findings past a job's share, as the program does", async () => {
    // Twenty agents: four jobs keep votes for one finding each and may report four.
    const tight: LocalWorkflowHostSnapshot = {
      ...snapshot,
      discover: { ...snapshot.discover!, maxAgents: 20 }
    }
    const answers: Record<string, unknown> = {
      'scout/map': areas,
      'find/r1/0/correctness': batch([
        finding('src/a.ts', 12, 'Double charge'),
        finding('src/a.ts', 60, 'Race on save'),
        finding('src/a.ts', 120, 'Lost update')
      ]),
      'find/r1/1/correctness': batch([finding('src/b.ts', 3, 'Token leak')]),
      'find/r1/1/security': batch([
        finding('src/c.ts', 9, 'Stale total'),
        finding('src/c.ts', 70, 'Wrong tax rounding')
      ])
    }
    const calls: WorkflowProgramCall[] = []
    const results = new Map<string, unknown>()
    const context = createWorkflowProgramContext({
      guard: () => {},
      isFatal: () => false,
      phase: () => {},
      log: () => {},
      agent: async (request) => {
        calls.push(request)
        const confirmed = [...new Set(request.dependencies.map((id) => id.split('/')[1]))]
        const value =
          answers[request.id] ??
          (request.id === 'find/r1/repeats'
            ? repeats([...request.prompt.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]))
            : request.id.startsWith('find/')
              ? batch()
              : request.id.startsWith('verify/')
                ? vote('real')
                : {
                    summary: 'Fix the double charge first.',
                    items: confirmed.map((id, index) => ({
                      rank: index + 1,
                      title: id,
                      location: 'src/a.ts:12',
                      severity: 'high',
                      scenario: 'Charged twice',
                      fix: 'Idempotency key',
                      findingIds: [id],
                      parallelSafe: true
                    })),
                    refutedIds: [],
                    unverifiedIds: []
                  })
        results.set(request.id, value)
        return value
      }
    })
    const program = await runDiscoverV7Program(
      context,
      discoverV7ConfigFromSnapshot(tight),
      tight.task
    )
    // The empty security job leaves one finding's votes: the race gets them, the rest wait out.
    expect(program.findings.map((entry) => entry.id)).toEqual([
      'r1-a0-correctness-0',
      'r1-a1-correctness-0',
      'r1-a1-security-0',
      'r1-a0-correctness-1'
    ])
    expect(program.dropped).toContain(
      'Round 1: set aside 2 findings beyond what the round could verify within 20 agents (Checkout · Correctness: 1; Payments · Security: 1).'
    )
    expect(calls.length).toBeLessThanOrEqual(20)
    for (const request of calls) {
      expect(workflowCallSeatId(tight, request.id)).toBe(request.seatId)
    }
    const run = projectDiscoverRun(
      tight,
      results,
      calls.map((request) => call(request.id, 'completed'))
    )!
    expect(run.findings.map((entry) => [entry.id, entry.status])).toEqual(
      program.findings.map((entry) => [entry.id, entry.status])
    )
    expect(run.dropped).toEqual(program.dropped)
    expect(run.report?.summary).toBe(program.report.summary)
    expect(discoverStageDefinitions(tight, results, undefined).map((stage) => stage.total)).toEqual(
      [1, 5, 12, 1]
    )
    // Before the round's last finder is in, nothing past a job's share is shown or planned.
    const early = new Map(results)
    early.delete('find/r1/1/security')
    const waiting = projectDiscoverRun(tight, early, [call('find/r1/1/security', 'running')])!
    expect(waiting.findings.map((entry) => entry.id)).toEqual([
      'r1-a0-correctness-0',
      'r1-a1-correctness-0'
    ])
  })

  it('keeps an unreadable revision 7 snapshot visible instead of throwing', () => {
    const broken = { ...snapshot, discover: { ...snapshot.discover!, finderIds: [] } }
    expect(projectDiscoverRun(broken, new Map(), [])).toMatchObject({ findings: [], round: 0 })
    expect(discoverResultMarkdown(broken, new Map())).toBeUndefined()
    expect(workflowCallSeatId(broken, 'find/r1/0/correctness')).toBeUndefined()
  })
})

describe('legacy Discover runs in the revision 7 shape', () => {
  const legacy: LocalWorkflowHostSnapshot = {
    ...snapshot,
    discoverProgramRevision: undefined,
    discover: createLocalWorkflowDraft('discover').discover
  }
  const config = legacy.discover!

  it('maps accepted findings and votes best-effort', () => {
    const high: FindingBatch = {
      findings: [
        {
          issueKey: 'double-charge',
          title: 'Double charge',
          location: 'src/pay.ts:12',
          trigger: 'Retry',
          impact: 'Charged twice',
          severity: 'high',
          evidence: [{ ref: 'src/pay.ts:12', description: 'No key' }]
        }
      ],
      omittedCount: 0,
      omissionReason: ''
    }
    const empty: FindingBatch = { findings: [], omittedCount: 0, omissionReason: '' }
    const batches = [high, empty, empty]
    const selection = selectDiscoverFindings(batches, { ...config, finderId: 'claude' })
    const id = selection.selected[0].id
    const results = new Map<string, unknown>(
      config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
    )
    for (const lens of config.lenses) {
      results.set(`refute/${id}/${lens}`, {
        refuted: false,
        uncertain: false,
        reason: 'Supported',
        evidence: []
      })
    }
    const run = projectDiscoverRun(legacy, results, [
      call(`discover/${config.dimensions[0]}`, 'completed')
    ])!
    expect(run.areas.map((area) => area.name)).toEqual(config.dimensions)
    expect(run.round).toBe(1)
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]).toMatchObject({
      id,
      title: 'Double charge',
      severity: 'high',
      location: 'src/pay.ts:12',
      status: 'confirmed'
    })
    expect(run.findings[0].votes.map((entry) => [entry.state, entry.verdict])).toEqual([
      ['done', 'real'],
      ['done', 'real']
    ])
  })

  it('settles a stopped legacy run whose verdicts never arrived', () => {
    const batches: FindingBatch[] = [
      {
        findings: [
          {
            issueKey: 'double-charge',
            title: 'Double charge',
            location: 'src/pay.ts:12',
            trigger: 'Retry',
            impact: 'Charged twice',
            severity: 'high',
            evidence: [{ ref: 'src/pay.ts:12', description: 'No key' }]
          }
        ],
        omittedCount: 0,
        omissionReason: ''
      },
      { findings: [], omittedCount: 0, omissionReason: '' },
      { findings: [], omittedCount: 0, omissionReason: '' }
    ]
    const results = new Map<string, unknown>(
      config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
    )
    const live = projectDiscoverRun(legacy, results, [])!
    expect(live.findings[0].status).toBe('verifying')
    expect(live.findings[0].votes.every((entry) => entry.state === 'pending')).toBe(true)
    const stopped = projectDiscoverRun(legacy, results, [], true)!
    expect(stopped.findings[0].status).toBe('unverified')
    expect(stopped.findings[0].votes.map((entry) => entry.state)).toEqual(
      config.lenses.map(() => 'failed')
    )
    expect(stopped.counts).toMatchObject({ verifying: 0, unverified: 1 })
  })

  it('never throws on malformed legacy evidence', () => {
    const results = new Map<string, unknown>(
      config.dimensions.map((dimension) => [`discover/${dimension}`, { findings: null }])
    )
    expect(() => projectDiscoverRun(legacy, results, [])).not.toThrow()
    expect(projectDiscoverRun(legacy, results, [])).toMatchObject({
      findings: [],
      counts: { found: 0 },
      maxRounds: 1
    })
  })
})
