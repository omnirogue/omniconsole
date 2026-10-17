import { describe, expect, it } from 'vitest'
import type { WorkflowProgramCall } from '../workflow-program-context'
import { runDiscoverV7Program } from './discover-v7'
import {
  discoverV7FindingId,
  discoverV7Jobs,
  discoverV7Verifiers,
  parseDiscoverV7FindingId,
  planDiscoverV7,
  type DiscoverV7Batch
} from './discover-v7-plan'
import { discoverV7FilesReadProblem, discoverV7RepeatsProblem } from './discover-v7-validate'
import {
  byId,
  config,
  finding,
  firstCalls,
  host,
  invocations,
  seat,
  task
} from './discover-v7.test-fixtures'

/** The live round-2 run: one off-by-one in reserve.ts reported three times in other words. */
const reworded: Record<string, Partial<DiscoverV7Batch>> = {
  'find/r1/0/correctness': {
    findings: [
      finding('src/reserve.ts', 9, 'Reservation loop allocates from the first excluded slot'),
      finding('src/reserve.ts', 16, 'Reservation responds before persistence completes')
    ]
  },
  'find/r1/0/security': {
    findings: [finding('src/reserve.ts', 9, 'reserve() loop runs i <= count past the window')]
  },
  'find/r1/1/correctness': {
    findings: [finding('src/store.ts', 22, 'Concurrent saves race through one tmp pathname')]
  },
  'find/r1/1/security': {
    findings: [finding('src/reserve.ts', 14, 'Off-by-one decrements slot count itself')]
  }
}
const group = (findingIds: string[]) => ({ findingIds, rootCause: 'The loop bound is i <= count' })
const offByOne = ['r1-a1-security-0', 'r1-a0-security-0', 'r1-a0-correctness-0']
const merged = () => ({
  groups: [group(offByOne), group(['r1-a0-correctness-1']), group(['r1-a1-correctness-0'])]
})
const verified = (calls: WorkflowProgramCall[]) => [
  ...new Set(
    firstCalls(calls)
      .filter((call) => call.id.startsWith('verify/'))
      .map((call) => call.id.split('/')[1])
  )
]

describe('Discover revision 7 repeat check', () => {
  it('groups rewordings the code key misses and verifies one report per defect', async () => {
    const fixture = host({ find: (call) => reworded[call.id], repeats: merged })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    // The earliest report in job order is the original, whatever order the answer lists.
    expect(result.findings.map((entry) => [entry.id, entry.duplicateOf])).toEqual([
      ['r1-a0-correctness-0', undefined],
      ['r1-a0-correctness-1', undefined],
      ['r1-a0-security-0', 'r1-a0-correctness-0'],
      ['r1-a1-correctness-0', undefined],
      ['r1-a1-security-0', 'r1-a0-correctness-0']
    ])
    expect(verified(fixture.calls)).toEqual([
      'r1-a0-correctness-0',
      'r1-a0-correctness-1',
      'r1-a1-correctness-0'
    ])
    // The scout, four finders, the check, nine votes and Rank: six votes were never spent.
    expect(fixture.calls).toHaveLength(16)
    const rank = byId(fixture.calls, 'rank/final')
    expect(rank.prompt).toContain('r1-a0-security-0 (Security lens, gemini)')
    expect(rank.prompt).toContain('r1-a1-security-0 (Security lens, codex)')
    expect(fixture.logs).toContain(
      'Round 1: the repeat check found 2 repeats among 5 new findings, so 3 are verified.'
    )
    expect(fixture.logs).toContain(
      'Verified 3 of 5 reported findings (2 repeats set aside): 3 confirmed, 0 refuted, 0 unverified.'
    )
  })

  it('retries a check that does not partition the new findings, and verifies all when it never does', async () => {
    let answers = 0
    const fixed = host({
      find: (call) => reworded[call.id],
      repeats: (ids) => {
        answers += 1
        // First the check drops an id and repeats another, then it answers properly.
        return answers === 1 ? { groups: [group([ids[0], ids[0]])] } : merged()
      }
    })
    const result = await runDiscoverV7Program(fixed.context, config(), task)
    expect(invocations(fixed.calls, 'find/r1/repeats')).toBe(2)
    expect(result.findings.filter((entry) => entry.duplicateOf)).toHaveLength(2)

    const silent = host({
      find: (call) => reworded[call.id],
      repeats: () => ({ groups: [group(['r9-a9-invented-0'])] })
    })
    const all = await runDiscoverV7Program(silent.context, config(), task)
    expect(invocations(silent.calls, 'find/r1/repeats')).toBe(3)
    expect(all.findings.some((entry) => entry.duplicateOf)).toBe(false)
    expect(verified(silent.calls)).toHaveLength(5)
    expect(silent.logs).toContain(
      'Round 1: the repeat check did not answer, so all 5 new findings are verified.'
    )
  })

  it('names every id that breaks the partition', () => {
    const ids = ['a', 'b', 'c']
    expect(discoverV7RepeatsProblem({ groups: [group(['a', 'b']), group(['c'])] }, ids)).toBeNull()
    expect(discoverV7RepeatsProblem({ groups: [group(['a', 'x']), group(['a', 'b'])] }, ids)).toBe(
      'Put every finding id in exactly one group and use only the ids given: unknown ids x; ids in more than one group a; missing ids c'
    )
  })

  it('runs no check when every new finding is in a file of its own', async () => {
    const fixture = host({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? {
              findings: [
                finding('src/a.ts', 12, 'Null crash'),
                finding('src/b.ts', 3, 'Token leak in logs')
              ]
            }
          : undefined
    })
    await runDiscoverV7Program(fixture.context, config(), task)
    expect(fixture.calls.some((call) => call.id.endsWith('/repeats'))).toBe(false)
    expect(verified(fixture.calls)).toEqual(['r1-a0-correctness-0', 'r1-a0-correctness-1'])
  })
})

describe('Discover revision 7 finders that read nothing', () => {
  const area = { name: 'Checkout', files: ['src/checkout', 'src/a.ts'], why: 'Charges' }
  const answer = (filesRead: string[]) => ({ findings: [], omitted: 0, filesRead })

  it("rejects an answer that lists none of the area's files", () => {
    expect(discoverV7FilesReadProblem(answer([]), area)).toBe(
      "Open the area's files before answering; you reported none."
    )
    expect(discoverV7FilesReadProblem({ findings: [], omitted: 0 }, area)).toBe(
      "Open the area's files before answering; you reported none."
    )
    expect(discoverV7FilesReadProblem(answer(['README.md', 'src/checkouts.ts']), area)).toBe(
      "Open the area's files before answering; none of the files you reported is in this area (src/checkout, src/a.ts)."
    )
    // A file inside an area folder, an absolute path in the workspace and ./ or :line all count.
    expect(discoverV7FilesReadProblem(answer(['src/checkout/pay.ts']), area)).toBeNull()
    expect(
      discoverV7FilesReadProblem(answer(['/Users/me/repo/src/a.ts']), area, '/Users/me/repo')
    ).toBeNull()
    expect(discoverV7FilesReadProblem(answer(['./src/a.ts:12']), area)).toBeNull()
    const whole = { ...area, files: ['.'] }
    expect(discoverV7FilesReadProblem(answer(['docs/any.md']), whole)).toBeNull()
  })

  it('reads an area entry the scout wrote as a glob by its literal lead', () => {
    const globbed = { ...area, files: ['src/checkout/*.ts', './src/pay/**/refund.ts'] }
    expect(discoverV7FilesReadProblem(answer(['src/checkout/pay.ts:40']), globbed)).toBeNull()
    expect(discoverV7FilesReadProblem(answer(['src/pay/v2/refund.ts']), globbed)).toBeNull()
    expect(
      discoverV7FilesReadProblem(
        answer(['/Users/me/repo/src/checkout/cart.ts']),
        { ...area, files: ['/Users/me/repo/src/checkout/*.ts'] },
        '/Users/me/repo'
      )
    ).toBeNull()
    expect(discoverV7FilesReadProblem(answer(['src/checkouts.ts']), globbed)).toBe(
      "Open the area's files before answering; none of the files you reported is in this area (src/checkout/*.ts, ./src/pay/**/refund.ts)."
    )
    expect(
      discoverV7FilesReadProblem(answer(['docs/any.md']), { ...area, files: ['**/*.ts'] })
    ).toBeNull()
  })

  it('retries a finder that answered without opening a file, and never counts it as searched', async () => {
    let empty = 0
    const fixture = host({
      find: (call) => {
        if (call.id === 'find/r1/0/correctness') {
          empty += 1
          return empty < 3
            ? { filesRead: [] }
            : { findings: [finding('src/a.ts', 12, 'Null crash')] }
        }
        return call.id === 'find/r1/1/security' ? { filesRead: [] } : undefined
      }
    })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    expect(invocations(fixture.calls, 'find/r1/0/correctness')).toBe(3)
    expect(byId(fixture.calls, 'find/r1/0/correctness').prompt).toContain(
      "Set filesRead to every file you opened for this answer (workspace-relative paths). An answer that lists none of your area's files is rejected"
    )
    expect(result.findings.map((entry) => entry.title)).toEqual(['Null crash'])
    // The finder that never read anything counts as having returned nothing.
    expect(invocations(fixture.calls, 'find/r1/1/security')).toBe(3)
    expect(fixture.logs).toContain(
      'Round 1: 1 reported, 1 new; 1 of 4 finder jobs returned nothing'
    )
  })

  it('exempts finders that only see attached files', async () => {
    const fixture = host({ find: () => ({ filesRead: [] }) })
    await runDiscoverV7Program(fixture.context, config({ access: 'frozen', focus: [] }), {
      prompt: task.prompt,
      evidence: '--- src/a.ts ---\n1 | export const total = 1'
    })
    expect(invocations(fixture.calls, 'find/r1/0/correctness')).toBe(1)
    expect(byId(fixture.calls, 'find/r1/0/correctness').prompt).toContain(
      'Set filesRead to the attached files you used.'
    )
  })
})

describe('Discover revision 7 votes and serialized accounts', () => {
  const serialized = planDiscoverV7(config({ serializedSeatIds: ['codex'] }))
  const rotation = (finderId: string) =>
    [0, 1, 2].flatMap((offset) => discoverV7Verifiers(serialized, finderId, offset))

  it('keeps votes off a serialized seat while another family can verify', () => {
    expect(new Set(rotation('grok'))).toEqual(new Set(['claude']))
    expect(new Set(rotation('claude'))).toEqual(new Set(['grok']))
    expect(new Set(rotation('gemini'))).toEqual(new Set(['claude', 'grok']))
    // A Codex finding goes to the other families as before.
    expect(new Set(rotation('codex'))).toEqual(new Set(['claude', 'grok']))
    // Without the hint every other family takes votes.
    expect(new Set(discoverV7Verifiers(planDiscoverV7(config()), 'grok', 0))).toEqual(
      new Set(['claude', 'codex'])
    )
  })

  it('still verifies across families when the only other family is serialized', () => {
    const plan = planDiscoverV7(
      config({
        seats: [seat('claude', 'claude', 'anthropic'), seat('codex', 'codex', 'openai')],
        finderIds: ['claude'],
        serializedSeatIds: ['codex']
      })
    )
    expect(discoverV7Verifiers(plan, 'claude', 0)).toEqual(['codex', 'codex', 'codex'])
  })

  it('gives a serialized finder at most one job a round while another finder can take the rest', () => {
    // The live round-3 layout: six areas and three lenses, with Claude, Codex and Grok finding.
    const layout = {
      finderIds: ['claude', 'codex', 'grok'],
      lensIds: ['correctness', 'reliability', 'security']
    }
    const six = Array.from({ length: 6 }, (_, index) => ({
      name: `Area ${index}`,
      files: [`src/${index}.ts`],
      why: 'Moves money'
    }))
    const seatsOf = (serializedSeatIds: string[], round: number) => {
      const plan = planDiscoverV7(config({ ...layout, serializedSeatIds }))
      const jobs = discoverV7Jobs(plan, six, round)
      // A call id alone names its finder, as the projection needs.
      for (const job of jobs) {
        expect(parseDiscoverV7FindingId(plan, discoverV7FindingId(job, 0))?.job.seatId).toBe(
          job.seatId
        )
      }
      return jobs.map((job) => job.seatId)
    }
    const count = (ids: string[], id: string) => ids.filter((seatId) => seatId === id).length
    expect(count(seatsOf([], 1), 'codex')).toBe(6)
    for (const round of [1, 2, 3]) {
      const seats = seatsOf(['codex'], round)
      expect(count(seats, 'codex')).toBe(1)
      expect(count(seats, 'claude') + count(seats, 'grok')).toBe(17)
      // Two serialized finders keep one job each; the only open finder takes the rest.
      const two = seatsOf(['codex', 'grok'], round)
      expect([count(two, 'codex'), count(two, 'grok'), count(two, 'claude')]).toEqual([1, 1, 16])
    }
    // Codex keeps its first job in job order; the other five go round Claude and Grok.
    const first = seatsOf(['codex'], 1)
    expect(first[0]).toBe('codex')
    expect([count(first, 'claude'), count(first, 'grok')]).toEqual([9, 8])
    // With every finder serialized there is no one to hand jobs to: the plain rotation stays.
    expect(seatsOf(['claude', 'codex', 'grok'], 2)).toEqual(seatsOf([], 2))
    // A run admitted before rules 2 replays with the plain rotation it ran with.
    const before = planDiscoverV7(
      config({ ...layout, serializedSeatIds: ['codex'], firstRules: true })
    )
    expect(discoverV7Jobs(before, six, 1).map((job) => job.seatId)).toEqual(seatsOf([], 1))
  })

  it('never sends a vote to the serialized seat in a run', async () => {
    const fixture = host({ find: (call) => reworded[call.id] })
    await runDiscoverV7Program(fixture.context, config({ serializedSeatIds: ['codex'] }), task)
    const votes = firstCalls(fixture.calls).filter((call) => call.id.startsWith('verify/'))
    expect(votes).toHaveLength(15)
    expect(votes.some((call) => call.seatId === 'codex')).toBe(false)
  })
})
