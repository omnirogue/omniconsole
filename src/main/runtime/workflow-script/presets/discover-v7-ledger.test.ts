import { describe, expect, it } from 'vitest'
import {
  createLocalWorkflowDraft,
  DISCOVER_LENS_IDS,
  DISCOVER_MIN_AGENTS,
  estimateDiscoverAgents,
  type DiscoverDepth
} from '../../../../shared/local-workflow-draft'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { WorkflowProgramSnapshot } from '../workflow-execution-service'
import {
  admitDiscoverV7Batch,
  applyDiscoverV7RepeatCheck,
  createDiscoverV7Ledger,
  fundDiscoverV7Extras,
  nextDiscoverV7Dry,
  planDiscoverV7RepeatCheck,
  startDiscoverV7Round
} from './discover-v7-ledger'
import { DISCOVER_V7_RULES, discoverV7ConfigFromSnapshot } from './discover-v7-config'
import { discoverV7DuplicateOf, discoverV7Similar, discoverV7TitleWords } from './discover-v7-dedup'
import {
  planDiscoverV7,
  type DiscoverV7Config,
  type DiscoverV7RawFinding,
  type DiscoverV7Record
} from './discover-v7-plan'

const seats: ResolvedLocalWorkflowSeat[] = (
  [
    ['claude', 'anthropic'],
    ['codex', 'openai'],
    ['grok', 'xai']
  ] as const
).map(([agent, lineage]) => ({
  id: agent,
  agent,
  accountId: `${agent}-account`,
  model: `${agent}-model`,
  effort: null,
  lineage,
  policyRevision: 'fixture-v1'
}))
function config(overrides: Partial<DiscoverV7Config> = {}): DiscoverV7Config {
  return {
    seats,
    finderIds: ['codex', 'grok'],
    rankerId: 'claude',
    lensIds: ['correctness', 'security'],
    depth: 'exhaustive',
    focus: [],
    maxAgents: 160,
    access: 'workspace-read',
    ...overrides
  }
}
const areas = ['Checkout', 'Payments', 'Refunds'].map((name) => ({
  name,
  files: [`src/${name.toLowerCase()}.ts`],
  why: 'Moves money'
}))
const emptyBatch = { findings: [], omitted: 0 }
const finding = (file: string, title: string, line = 12): DiscoverV7RawFinding => ({
  title,
  file,
  line,
  endLine: null,
  severity: 'high',
  trigger: 'Two tabs submit at once',
  scenario: 'The card is charged twice',
  evidence: 'No idempotency key',
  fix: 'Add an idempotency key'
})

describe('Discover revision 7 budget', () => {
  it('runs every job in area order when the budget allows it', () => {
    const ledger = createDiscoverV7Ledger()
    const jobs = startDiscoverV7Round(planDiscoverV7(config()), ledger, areas, 1)
    expect(jobs.map((job) => [job.callId, job.findingLimit])).toEqual([
      ['find/r1/0/correctness', 8],
      ['find/r1/0/security', 8],
      ['find/r1/1/correctness', 8],
      ['find/r1/1/security', 8],
      ['find/r1/2/correctness', 8],
      ['find/r1/2/security', 8]
    ])
    // The scout, six finders, three votes for every finding they may report and the repeat check.
    expect(ledger).toMatchObject({ used: 1 + 6 + 6 * 8 * 3 + 1, jobsRun: 6, dropped: [] })
  })

  it('spreads a capped round across areas and resumes where the last round stopped', () => {
    // One scout and one rank reserve leave twelve calls: three finder jobs of four calls each.
    const plan = planDiscoverV7(config({ maxAgents: 14 }))
    const ledger = createDiscoverV7Ledger()
    const round = (index: number) => {
      const jobs = startDiscoverV7Round(plan, ledger, areas, index)
      // Nothing found: each job gives back the votes it kept in reserve, and the round the call
      // it kept for a repeat check.
      jobs.forEach((job) => admitDiscoverV7Batch(plan, ledger, areas, job, emptyBatch))
      expect(planDiscoverV7RepeatCheck(plan, ledger, index)).toBeUndefined()
      return jobs.map((job) => job.callId)
    }
    expect(round(1)).toEqual([
      'find/r1/0/correctness',
      'find/r1/1/correctness',
      'find/r1/2/correctness'
    ])
    expect(ledger.dropped).toEqual([
      'Round 1: skipped 3 of 6 finder jobs to stay within 14 agents (Checkout · Security; Payments · Security; Refunds · Security).',
      'Round 1: 3 new findings can get their 3 votes within 14 agents, so each finder job keeps votes for 1 finding; a job may report up to 3, and findings past its share get the votes other jobs leave unused.'
    ])
    expect(round(2)).toEqual(['find/r2/0/security', 'find/r2/1/security'])
    expect(round(3)).toEqual(['find/r3/2/security'])
    expect(ledger).toMatchObject({ used: 7, jobsRun: 6 })
  })

  it('plans the first finder job at exactly the minimum budget admission allows', () => {
    const smallest = createDiscoverV7Ledger()
    const jobs = startDiscoverV7Round(
      planDiscoverV7(config({ maxAgents: DISCOVER_MIN_AGENTS })),
      smallest,
      areas,
      1
    )
    expect(jobs.map((job) => [job.callId, job.findingLimit])).toEqual([
      ['find/r1/0/correctness', 1]
    ])
    // The scout, the finder and its three reserved votes, with the last call held for Rank.
    expect(smallest.used + 1).toBe(DISCOVER_MIN_AGENTS)
    const below = createDiscoverV7Ledger()
    expect(
      startDiscoverV7Round(
        planDiscoverV7(config({ maxAgents: DISCOVER_MIN_AGENTS - 1 })),
        below,
        areas,
        1
      )
    ).toEqual([])
  })

  it('logs every job when the budget leaves no room for a finder', () => {
    const ledger = createDiscoverV7Ledger()
    expect(
      startDiscoverV7Round(planDiscoverV7(config({ maxAgents: 5 })), ledger, areas, 1)
    ).toEqual([])
    expect(ledger.dropped).toEqual([
      'Round 1: skipped 6 of 6 finder jobs to stay within 5 agents (Checkout · Correctness; Checkout · Security; Payments · Correctness; Payments · Security; Refunds · Correctness; Refunds · Security).'
    ])
  })

  it('verifies every finding a job keeps and gives back the votes repeats did not need', () => {
    // 38 free calls: six jobs and ten findings between them, two for the first four served.
    const plan = planDiscoverV7(config({ maxAgents: 40 }))
    const ledger = createDiscoverV7Ledger()
    const jobs = startDiscoverV7Round(plan, ledger, areas, 1)
    expect(jobs.map((job) => [job.findingLimit, job.reportLimit])).toEqual([
      [2, 8],
      [2, 8],
      [2, 8],
      [1, 8],
      [2, 8],
      [1, 8]
    ])
    expect(ledger.dropped).toEqual([
      'Round 1: 10 new findings can get their 3 votes within 40 agents, so each finder job keeps votes for 1 or 2 findings; a job may report up to 8, and findings past its share get the votes other jobs leave unused.'
    ])
    // The scout, six finders, their votes and the call kept for the round's repeat check.
    expect(ledger.used).toBe(1 + 6 + 10 * 3 + 1)
    const batch = (findings: DiscoverV7RawFinding[]) => ({ findings, omitted: 0 })
    const fresh = admitDiscoverV7Batch(plan, ledger, areas, jobs[0], {
      findings: [
        finding('src/checkout.ts', 'Double charge on retry', 12),
        finding('src/checkout.ts', 'Lost update on save', 80),
        finding('src/checkout.ts', 'Stale total after edit', 140)
      ],
      omitted: 1
    })
    expect(fresh.map((record) => [record.id, record.verifiers?.length])).toEqual([
      ['r1-a0-correctness-0', 3],
      ['r1-a0-correctness-1', 3]
    ])
    // The third finding waits for the votes other jobs leave; only what the finder omitted is out.
    expect(ledger.records).toHaveLength(2)
    expect(ledger.dropped.at(-1)).toBe(
      'Round 1, Checkout · Correctness: the finder left out 1 more finding beyond its limit of 8.'
    )
    // A repeat worded differently is recorded, not verified, and its two votes go back.
    const repeat = admitDiscoverV7Batch(
      plan,
      ledger,
      areas,
      jobs[1],
      batch([finding('src/checkout.ts', 'Retry double charges the card', 20)])
    )
    expect(repeat).toEqual([])
    expect(ledger.records.at(-1)).toMatchObject({
      id: 'r1-a0-security-0',
      duplicateOf: 'r1-a0-correctness-0'
    })
    expect(ledger.records.at(-1)?.verifiers).toBeUndefined()
    expect(ledger.used).toBe(1 + 6 + 10 * 3 + 1 - 2 * 3)
    admitDiscoverV7Batch(plan, ledger, areas, jobs[2], null)
    expect(ledger).toMatchObject({ used: 1 + 6 + 10 * 3 + 1 - 4 * 3, failed: 1, searched: 2 })
  })

  it('gives the votes a round did not need to findings past other jobs, breadth first in job order', () => {
    // 38 free calls: six jobs keep votes for ten findings, two each for the first four served.
    const plan = planDiscoverV7(config({ maxAgents: 40 }))
    const ledger = createDiscoverV7Ledger()
    const jobs = startDiscoverV7Round(plan, ledger, areas, 1)
    const planned = ledger.used
    const many = (file: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        finding(file, `Defect ${index} of ${file}`, 12 + 100 * index)
      )
    // Shares 2, 2, 2, 1, 2, 1. Four jobs find nothing or fail, leaving seven findings' votes.
    const batches = [
      { findings: many('src/checkout.ts', 5), omitted: 0 },
      emptyBatch,
      null,
      {
        findings: [
          ...many('src/payments.ts', 3),
          finding('src/checkout.ts', 'Defect 1 of src/checkout.ts', 115)
        ],
        omitted: 0
      },
      emptyBatch,
      emptyBatch
    ]
    jobs.forEach((job, index) => admitDiscoverV7Batch(plan, ledger, areas, job, batches[index]))
    expect(ledger.records.map((record) => record.id)).toEqual([
      'r1-a0-correctness-0',
      'r1-a0-correctness-1',
      'r1-a1-security-0'
    ])
    // Three fresh of ten kept: the seven spare findings' votes are released at admission.
    expect(ledger.used).toBe(planned - 7 * 3)
    expect(fundDiscoverV7Extras(plan, ledger, areas, jobs, batches)).toBe(5)
    // Each job's first further finding before any job's second; job 3's last repeats job 0's
    // second report, so it is recorded for free.
    expect(ledger.records.slice(3).map((record) => [record.id, record.duplicateOf])).toEqual([
      ['r1-a0-correctness-2', undefined],
      ['r1-a1-security-1', undefined],
      ['r1-a0-correctness-3', undefined],
      ['r1-a1-security-2', undefined],
      ['r1-a0-correctness-4', undefined],
      ['r1-a1-security-3', 'r1-a0-correctness-1']
    ])
    expect(ledger.records.slice(3).filter((record) => record.verifiers)).toHaveLength(5)
    // Five of the seven are spent; two findings' votes stay unused.
    expect(ledger.used).toBe(planned - 2 * 3)
    expect(ledger.dropped).toHaveLength(1)
    // With every spare vote spent, the next further finding is set aside and logged.
    const tight = createDiscoverV7Ledger()
    const tightJobs = startDiscoverV7Round(plan, tight, areas, 1)
    const full = tightJobs.map((job) => ({
      findings: many(`src/${job.callId.replaceAll('/', '-')}.ts`, job.findingLimit + 1),
      omitted: 0
    }))
    tightJobs.forEach((job, index) => admitDiscoverV7Batch(plan, tight, areas, job, full[index]))
    const before = tight.used
    expect(fundDiscoverV7Extras(plan, tight, areas, tightJobs, full)).toBe(0)
    expect(tight.used).toBe(before)
    expect(tight.dropped.at(-1)).toBe(
      'Round 1: set aside 6 findings beyond what the round could verify within 40 agents (Checkout · Correctness: 1; Checkout · Security: 1; Payments · Correctness: 1; Payments · Security: 1; Refunds · Correctness: 1; Refunds · Security: 1).'
    )
  })

  it('keeps each finder job of a run admitted before rules 2 to its share, as it ran', () => {
    const plan = planDiscoverV7(config({ maxAgents: 40, firstRules: true }))
    const ledger = createDiscoverV7Ledger()
    const jobs = startDiscoverV7Round(plan, ledger, areas, 1)
    expect(jobs.map((job) => [job.findingLimit, job.reportLimit])).toEqual([
      [2, 2],
      [2, 2],
      [2, 2],
      [1, 1],
      [2, 2],
      [1, 1]
    ])
    const limit =
      'Round 1: 10 new findings can get their 3 votes within 40 agents, so each finder job keeps votes for 1 or 2 findings.'
    expect(ledger.dropped).toEqual([limit])
    // Five jobs find nothing, yet the third checkout finding stays out: its finder was asked for two.
    const batches = [
      {
        findings: [
          finding('src/checkout.ts', 'Double charge on retry', 12),
          finding('src/checkout.ts', 'Lost update on save', 80),
          finding('src/checkout.ts', 'Stale total after edit', 140)
        ],
        omitted: 0
      },
      ...jobs.slice(1).map(() => emptyBatch)
    ]
    jobs.forEach((job, index) => admitDiscoverV7Batch(plan, ledger, areas, job, batches[index]))
    expect(fundDiscoverV7Extras(plan, ledger, areas, jobs, batches)).toBe(0)
    expect(ledger.records.map((record) => record.id)).toEqual([
      'r1-a0-correctness-0',
      'r1-a0-correctness-1'
    ])
    expect(ledger.dropped).toEqual([
      limit,
      'Round 1, Checkout · Correctness: the finder left out 1 more finding beyond its limit of 2.'
    ])
    // The scout, six finders, the two findings' votes and the call kept for the repeat check.
    expect(ledger.used).toBe(1 + 6 + 2 * 3 + 1)
  })

  it('runs the repeat check only when two new findings share a file, and returns its call otherwise', () => {
    const plan = planDiscoverV7(config({ maxAgents: 40, lensIds: ['correctness'] }))
    const round = (findings: DiscoverV7RawFinding[][]) => {
      const ledger = createDiscoverV7Ledger()
      const jobs = startDiscoverV7Round(plan, ledger, areas, 1)
      jobs.forEach((job, index) =>
        admitDiscoverV7Batch(plan, ledger, areas, job, {
          findings: findings[index] ?? [],
          omitted: 0
        })
      )
      return { ledger, planned: ledger.used }
    }
    const apart = round([[finding('src/checkout.ts', 'Double charge on retry')]])
    expect(planDiscoverV7RepeatCheck(plan, apart.ledger, 1)).toBeUndefined()
    expect(apart.ledger.used).toBe(apart.planned - 1)
    const shared = round([
      [finding('src/checkout.ts', 'Double charge on retry', 12)],
      [finding('./src/checkout.ts', 'Stale total after edit', 80)]
    ])
    const candidates = planDiscoverV7RepeatCheck(plan, shared.ledger, 1)
    expect(candidates?.map((record) => record.id)).toEqual([
      'r1-a0-correctness-0',
      'r1-a1-correctness-0'
    ])
    // The call is spent; one repeat gives back its three votes and is never verified.
    expect(shared.ledger.used).toBe(shared.planned)
    const fresh = applyDiscoverV7RepeatCheck(shared.ledger, candidates!, {
      groups: [{ findingIds: ['r1-a1-correctness-0', 'r1-a0-correctness-0'], rootCause: 'Retry' }]
    })
    expect(fresh.map((record) => record.id)).toEqual(['r1-a0-correctness-0'])
    expect(shared.ledger.records[1]).toMatchObject({ duplicateOf: 'r1-a0-correctness-0' })
    expect(shared.ledger.records[1].verifiers).toBeUndefined()
    expect(shared.ledger.used).toBe(shared.planned - 3)
    // A check that never answered merges nothing.
    const silent = round([
      [finding('src/checkout.ts', 'Double charge on retry', 12)],
      [finding('src/checkout.ts', 'Stale total after edit', 80)]
    ])
    const all = planDiscoverV7RepeatCheck(plan, silent.ledger, 1)!
    expect(applyDiscoverV7RepeatCheck(silent.ledger, all, null)).toHaveLength(2)
    expect(silent.ledger.used).toBe(silent.planned)
  })

  it('names a round that had no call left for its repeat check', () => {
    // Ten agents: two finder jobs of one finding each fill the budget, so no check is kept.
    const plan = planDiscoverV7(config({ maxAgents: 10, lensIds: ['correctness'] }))
    const ledger = createDiscoverV7Ledger()
    const jobs = startDiscoverV7Round(plan, ledger, areas, 1)
    expect(jobs.map((job) => job.findingLimit)).toEqual([1, 1])
    jobs.forEach((job, index) =>
      admitDiscoverV7Batch(plan, ledger, areas, job, {
        findings: [finding('src/checkout.ts', `Defect ${index} in checkout`, 12 + 100 * index)],
        omitted: 0
      })
    )
    const used = ledger.used
    expect(planDiscoverV7RepeatCheck(plan, ledger, 1)).toBeUndefined()
    expect(ledger.used).toBe(used)
    expect(ledger.dropped.at(-1)).toBe(
      'Round 1: no agent was left to check 2 new findings for repeats, so each one is verified.'
    )
  })

  it('never plans a run outside the agent estimate, and reaches both of its ends', () => {
    // A fixed pseudo-random walk over maps, budgets and finder outcomes through the real planner.
    let seed = 42
    const pick = (count: number) => {
      seed = (seed * 48271) % 2147483647
      return seed % count
    }
    const reached = { low: 0, high: 0 }
    for (let run = 0; run < 400; run++) {
      const lensIds = DISCOVER_LENS_IDS.slice(0, 1 + pick(DISCOVER_LENS_IDS.length))
      const depth = (['quick', 'thorough', 'exhaustive'] as DiscoverDepth[])[pick(3)]
      const maxAgents = DISCOVER_MIN_AGENTS + pick(200)
      const plan = planDiscoverV7(config({ lensIds, depth, maxAgents }))
      const map = Array.from({ length: 1 + pick(8) }, (_, index) => ({
        name: `Area ${index}`,
        files: [`src/${index}.ts`],
        why: 'Moves money'
      }))
      const style = pick(3)
      // Some runs keep each finding in a file of its own, the rest put a job's findings in one.
      const oneFile = pick(2) === 1
      const ledger = createDiscoverV7Ledger()
      let calls = 1
      let fresh = 0
      let dry = 0
      for (let round = 1; round <= plan.maxRounds; round++) {
        const jobs = startDiscoverV7Round(plan, ledger, map, round)
        if (!jobs.length) {
          break
        }
        calls += jobs.length
        // Finders may report past their share, up to what the round could verify in all.
        const batches = jobs.map((job) => {
          const count = style === 0 ? 0 : style === 1 ? job.reportLimit : pick(job.reportLimit + 1)
          const findings = Array.from({ length: count }, (_, index) =>
            finding(
              oneFile ? `src/${job.callId}.ts` : `src/${job.callId}-${index}.ts`,
              `Defect ${index} of ${job.callId}`,
              12 + 100 * index
            )
          )
          const batch = { findings, omitted: 0 }
          admitDiscoverV7Batch(plan, ledger, map, job, batch)
          return batch
        })
        fundDiscoverV7Extras(plan, ledger, map, jobs, batches)
        const candidates = planDiscoverV7RepeatCheck(plan, ledger, round)
        if (candidates) {
          calls += 1
          // The check merges a random share of the round into its first finding.
          const merged = candidates.filter((_, index) => index > 0 && pick(2) === 1)
          applyDiscoverV7RepeatCheck(ledger, candidates, {
            groups: [
              {
                findingIds: [candidates[0].id, ...merged.map((record) => record.id)],
                rootCause: 'One'
              },
              ...candidates
                .slice(1)
                .filter((record) => !merged.includes(record))
                .map((record) => ({ findingIds: [record.id], rootCause: 'Own' }))
            ]
          })
        }
        const added = ledger.records.filter(
          (record) => record.round === round && !record.duplicateOf
        ).length
        calls += added * 3
        fresh += added
        const next = nextDiscoverV7Dry(plan, ledger, round, dry)
        dry = next.dry
        if (next.stop) {
          break
        }
      }
      calls += fresh ? 1 : 0
      const estimate = estimateDiscoverAgents(lensIds.length, depth, maxAgents)
      expect(calls).toBeGreaterThanOrEqual(estimate.low)
      expect(calls).toBeLessThanOrEqual(estimate.high)
      expect(estimate.high).toBeLessThanOrEqual(maxAgents)
      reached.low += calls === estimate.low ? 1 : 0
      reached.high += calls === estimate.high ? 1 : 0
    }
    expect(reached.low).toBeGreaterThan(0)
    expect(reached.high).toBeGreaterThan(0)
  })
})

describe('Discover revision 7 near duplicates', () => {
  const same = (left: DiscoverV7RawFinding, right: DiscoverV7RawFinding) =>
    discoverV7Similar(left, right, '/Users/me/repo')

  it('treats the same file written three ways as one path', () => {
    const base = finding('src/a.ts', 'Null crash', 12)
    expect(same(base, finding('/Users/me/repo/src/a.ts', 'Null  crash!', 12))).toBe(true)
    expect(same(base, finding('./src/a.ts', 'null crash', 12))).toBe(true)
    expect(same(base, finding('src\\a.ts', 'Null crash', 12))).toBe(true)
    expect(same(base, finding('/Users/me/repository/src/a.ts', 'Null crash', 12))).toBe(false)
    expect(same(base, finding('src/b.ts', 'Null crash', 12))).toBe(false)
  })

  it('matches lines within twelve of each other or overlapping ranges', () => {
    const base = finding('src/a.ts', 'Null crash', 30)
    expect(same(base, finding('src/a.ts', 'Null crash', 42))).toBe(true)
    expect(same(base, finding('src/a.ts', 'Null crash', 43))).toBe(false)
    expect(same(base, { ...finding('src/a.ts', 'Null crash', 1), endLine: 18 })).toBe(true)
    expect(same({ ...base, endLine: 90 }, finding('src/a.ts', 'Null crash', 80))).toBe(true)
  })

  it('matches the same defect worded differently, not a different defect nearby', () => {
    const base = finding('src/reserve.ts', 'reserve() does not await store.save()', 16)
    expect(same(base, finding('src/reserve.ts', 'Store save is not awaited in reserve', 16))).toBe(
      true
    )
    expect(
      same(
        finding('src/quote.ts', 'Quote total ignores unitCents rounding', 9),
        finding('src/quote.ts', 'unit_cents rounding ignored in the quote total', 12)
      )
    ).toBe(true)
    expect(same(base, finding('src/reserve.ts', 'Token leak in reserve logging', 18))).toBe(false)
  })

  it('drops stopwords before plurals, so "does" and "this" never count as shared words', () => {
    expect(discoverV7TitleWords('This does not expire caches')).toEqual(
      new Set(['expire', 'cache'])
    )
    // As "doe" the stopword would lift these two different defects to a Jaccard of 0.5.
    expect(
      same(
        finding('src/a.ts', 'Session does not expire', 12),
        finding('src/a.ts', 'Token does not expire', 12)
      )
    ).toBe(false)
  })

  it('keeps titles in other scripts apart', () => {
    const base = finding('src/a.ts', '二重請求', 12)
    expect(same(base, finding('src/a.ts', '二重請求', 14))).toBe(true)
    expect(same(base, finding('src/a.ts', '在庫の競合', 14))).toBe(false)
    expect(discoverV7TitleWords('Двойное списание')).toEqual(new Set(['двойное', 'списание']))
  })

  it('matches a report only against verified reports, never through a repeat', () => {
    const record = (id: string, line: number, duplicateOf?: string): DiscoverV7Record => ({
      id,
      round: 1,
      areaIndex: 0,
      lensId: 'correctness',
      findCallId: 'find/r1/0/correctness',
      finderId: 'codex',
      finding: finding('src/checkout.ts', 'Double charge on retry', line),
      ...(duplicateOf ? { duplicateOf } : {})
    })
    // The repeat at 22 is within twelve lines of the original at 10; 34 is not.
    const records = [record('a', 10), record('b', 22, 'a')]
    const at = (line: number) =>
      discoverV7DuplicateOf(records, finding('src/checkout.ts', 'Retry double charge', line))
    expect(at(21)).toBe('a')
    expect(at(34)).toBeUndefined()
    // With a second original nearby, the earliest match wins.
    expect(
      discoverV7DuplicateOf(
        [...records, record('c', 30)],
        finding('src/checkout.ts', 'Double charge on retry', 20)
      )
    ).toBe('a')
  })
})

describe('Discover revision 7 config', () => {
  it('takes the workspace root from the frozen host snapshot', () => {
    const snapshot: WorkflowProgramSnapshot = {
      version: 1,
      discoverProgramRevision: 7,
      access: 'workspace-read',
      task: { prompt: 'Find bugs', evidence: '' },
      seats,
      synthesizerId: 'claude',
      discover: {
        ...createLocalWorkflowDraft('discover').discover,
        finderIds: ['codex'],
        lensIds: ['correctness']
      },
      host: { workspaceRoot: { path: '/Users/me/repo', device: '1', inode: '2' } }
    }
    expect(discoverV7ConfigFromSnapshot(snapshot)).toMatchObject({
      finderIds: ['codex'],
      rankerId: 'claude',
      depth: 'thorough',
      maxAgents: 160,
      access: 'workspace-read',
      workspaceRoot: '/Users/me/repo'
    })
    expect(discoverV7ConfigFromSnapshot({ ...snapshot, host: null })).not.toHaveProperty(
      'workspaceRoot'
    )
  })

  it('plans by the rules frozen at admission, and a snapshot from before rules 2 as it ran', () => {
    const snapshot: WorkflowProgramSnapshot = {
      version: 1,
      discoverProgramRevision: 7,
      task: { prompt: 'Find bugs', evidence: '' },
      seats,
      synthesizerId: 'claude',
      discover: { ...createLocalWorkflowDraft('discover').discover, finderIds: ['codex'] },
      host: { discoverRules: DISCOVER_V7_RULES }
    }
    expect(discoverV7ConfigFromSnapshot(snapshot)).not.toHaveProperty('firstRules')
    for (const host of [{}, { discoverRules: 1 }, { discoverRules: '2' }, null]) {
      expect(discoverV7ConfigFromSnapshot({ ...snapshot, host })).toMatchObject({
        firstRules: true
      })
    }
  })
})
