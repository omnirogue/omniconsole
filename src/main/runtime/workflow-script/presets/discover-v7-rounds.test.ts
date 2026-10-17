import { describe, expect, it } from 'vitest'
import { validateJsonSchema } from '../../../../shared/json-schema-validate'
import { estimateDiscoverAgents } from '../../../../shared/local-workflow-draft'
import type { WorkflowProgramCall } from '../workflow-program-context'
import { runDiscoverV7Program } from './discover-v7'
import type { DiscoverV7RawFinding, DiscoverV7Vote } from './discover-v7-plan'
import verdictSchema from './schemas/verdict-files-v7.schema.json'
import { discoverV7RankedSummary, type DiscoverV7ReportItem } from './discover-v7-report'
import { discoverV7FindingsProblem, discoverV7VoteProblem } from './discover-v7-validate'
import {
  byId,
  config,
  finding,
  firstCalls,
  host,
  invocations,
  task,
  vote
} from './discover-v7.test-fixtures'

const stub: DiscoverV7RawFinding = {
  title: 'placeholder',
  file: 'src/notify.ts',
  line: 1,
  endLine: null,
  severity: 'high',
  trigger: 't',
  scenario: 's',
  evidence: 'e',
  fix: 'f'
}
const at = (events: string[], event: string) => {
  const index = events.indexOf(event)
  expect(index, event).toBeGreaterThanOrEqual(0)
  return index
}
const firstAt = (events: string[], prefix: string) => {
  const index = events.findIndex((event) => event.startsWith(prefix))
  expect(index, prefix).toBeGreaterThanOrEqual(0)
  return index
}

describe('Discover revision 7 answers', () => {
  it('rejects placeholder findings and names every field that is not a real report', () => {
    const problem = discoverV7FindingsProblem({ findings: [stub], omitted: 0 })
    expect(problem).toContain('finding 1 ("placeholder")')
    for (const field of ['title', 'trigger', 'scenario', 'evidence', 'fix']) {
      expect(problem).toContain(`${field} is a placeholder`)
    }
    const real = finding('src/a.ts', 12, 'Null crash')
    expect(discoverV7FindingsProblem({ findings: [real], omitted: 0 })).toBeNull()
    const check = (change: Partial<DiscoverV7RawFinding>) =>
      discoverV7FindingsProblem({ findings: [real, { ...real, ...change }], omitted: 0 })
    expect(check({ title: 'TODO bug' })).toContain('finding 2 ("TODO bug"): title is a placeholder')
    expect(check({ scenario: 'Crashes' })).toContain('scenario "Crashes" is too short')
    expect(check({ file: '/etc/passwd' })).toContain('must be a path relative to the workspace')
    expect(check({ file: '../outside.ts' })).toContain('does not name a real file')
    expect(check({ file: 'path/to/file.ts' })).toContain('does not name a real file')
    expect(check({ file: 'unknown' })).toContain('does not name a real file')
    expect(check({ line: 0 })).toContain('line must be 1 or more')
    // A real file may have a plain name, a path inside the workspace is relative, wide scripts count.
    expect(check({ file: 'test.ts' })).toBeNull()
    expect(
      discoverV7FindingsProblem(
        { findings: [{ ...real, file: '/Users/me/repo/src/a.ts' }], omitted: 0 },
        '/Users/me/repo'
      )
    ).toBeNull()
    expect(check({ title: '二重請求' })).toBeNull()
    expect(
      discoverV7VoteProblem({ verdict: 'real', reason: 'r', evidence: '' }, 'frozen')
    ).toContain('reason is a placeholder')
    expect(discoverV7VoteProblem(vote('refuted'), 'workspace-read')).toBeNull()
  })

  it('rejects a vote that cites no code or opened no file, and exempts frozen verifiers from filesRead', () => {
    // The live round-3 Grok vote: answered in 4 s from about 2k tokens, having read nothing.
    const noOp: DiscoverV7Vote = {
      verdict: 'unjudged',
      reason: 'Need to inspect the PUT handler and its callers before judging',
      evidence: '',
      filesRead: []
    }
    expect(discoverV7VoteProblem(noOp, 'workspace-read')).toBe(
      'Open the files before voting; you cited none. Set filesRead to every file you opened. Give the evidence: file:line and what the code there does.'
    )
    // Evidence alone is not enough when the verifier could open the workspace, and the reverse.
    const cited = { ...noOp, evidence: 'src/server.ts:41 calls updateItem with no auth check' }
    expect(discoverV7VoteProblem(cited, 'workspace-read')).toBe(
      'Open the files before voting; you cited none. Set filesRead to every file you opened.'
    )
    expect(discoverV7VoteProblem({ ...cited, filesRead: ['  '] }, 'workspace-read')).toContain(
      'Set filesRead'
    )
    // A placeholder is not a file read.
    expect(discoverV7VoteProblem({ ...cited, filesRead: ['N/A', '.'] }, 'workspace-read')).toBe(
      'Open the files before voting; you cited none. Set filesRead to every file you opened.'
    )
    const opened = { ...noOp, filesRead: ['src/server.ts'], evidence: 'n/a' }
    expect(discoverV7VoteProblem(opened, 'workspace-read')).toBe(
      'Open the files before voting; you cited none. Give the evidence: file:line and what the code there does.'
    )
    expect(
      discoverV7VoteProblem({ ...cited, filesRead: ['src/server.ts'] }, 'workspace-read')
    ).toBeNull()
    // A frozen verifier reads attached text: it needs evidence but no filesRead.
    expect(discoverV7VoteProblem(cited, 'frozen')).toBeNull()
    expect(discoverV7VoteProblem(noOp, 'frozen')).toBe(
      'Read the attached files before voting; you cited none. Give the evidence: file:line and what the code there does.'
    )
    // The verdict schema itself asks for the files, so structured output always carries the field.
    const legacy = { verdict: cited.verdict, reason: cited.reason, evidence: cited.evidence }
    expect(validateJsonSchema(verdictSchema, legacy)).not.toEqual([])
    expect(validateJsonSchema(verdictSchema, cited)).toEqual([])
  })

  it('retries a vote that read nothing and counts it only once it cites code', async () => {
    const answers = new Map<string, number>()
    const fixture = host({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? { findings: [finding('src/a.ts', 12, 'Null crash')] }
          : undefined,
      verify: (id, lens) => {
        const key = `${id}/${lens}`
        answers.set(key, (answers.get(key) ?? 0) + 1)
        // Reachability answers twice without reading anything; reproduction never reads.
        const noOp = lens === 'reproduction' || (lens === 'reachability' && answers.get(key)! < 3)
        return noOp
          ? {
              verdict: 'unjudged',
              reason: 'Need to inspect the handler first',
              evidence: '',
              filesRead: []
            }
          : vote('real')
      }
    })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    expect(invocations(fixture.calls, 'verify/r1-a0-correctness-0/correctness')).toBe(1)
    expect(invocations(fixture.calls, 'verify/r1-a0-correctness-0/reachability')).toBe(3)
    // Its attempts ran out: the vote stays unjudged, never a refute and never a real.
    expect(invocations(fixture.calls, 'verify/r1-a0-correctness-0/reproduction')).toBe(3)
    expect(fixture.results.has('verify/r1-a0-correctness-0/reproduction')).toBe(false)
    expect(result.findings).toEqual([
      { id: 'r1-a0-correctness-0', title: 'Null crash', status: 'confirmed' }
    ])
    const prompt = byId(fixture.calls, 'verify/r1-a0-correctness-0/reachability').prompt
    expect(prompt).toContain(
      'Set filesRead to every file you opened for this vote (workspace-relative paths). A vote that lists no file or gives no evidence is rejected, so open the files before you vote, even to answer unjudged.'
    )
  })

  it('retries a finder that answered with a placeholder until it reports a real defect', async () => {
    let stubs = 0
    const fixture = host({
      find: (call) => {
        if (call.id !== 'find/r1/0/security') {
          return undefined
        }
        stubs += 1
        return stubs < 3
          ? { findings: [stub] }
          : { findings: [finding('src/a.ts', 12, 'Null crash')] }
      }
    })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    expect(invocations(fixture.calls, 'find/r1/0/security')).toBe(3)
    expect(result.findings.map((entry) => entry.title)).toEqual(['Null crash'])
  })

  it('never turns a finder that only answers with placeholders into a finding', async () => {
    const fixture = host({
      find: (call) => (call.id === 'find/r1/0/security' ? { findings: [stub] } : undefined)
    })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    expect(invocations(fixture.calls, 'find/r1/0/security')).toBe(3)
    expect(result.findings).toEqual([])
    expect(fixture.calls.some((call) => call.id.startsWith('verify/'))).toBe(false)
    expect(result.report.summary).toContain('1 of 4 finder jobs returned nothing')
  })
})

describe('Discover revision 7 scheduling', () => {
  it('starts the next round while the votes of this one are still out', async () => {
    const fixture = host({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? { findings: [finding('src/a.ts', 12, 'Null crash')] }
          : undefined,
      delay: (call) => (call.id.startsWith('verify/') ? 30 : 0)
    })
    await runDiscoverV7Program(
      fixture.context,
      config({ depth: 'thorough', lensIds: ['correctness'] }),
      task
    )
    const { events } = fixture
    expect(at(events, 'start find/r2/0/correctness')).toBeLessThan(firstAt(events, 'end verify/'))
    // Rank still waits for every vote.
    expect(at(events, 'start rank/final')).toBeGreaterThan(
      at(events, 'end verify/r1-a0-correctness-0/reproduction')
    )
  })

  it('verifies nothing of a round before its last finder is in and its repeats are checked', async () => {
    const run = async (perJob: number) => {
      const fixture = host({
        find: (call) => ({
          findings: Array.from({ length: perJob }, (_, index) =>
            finding(`src/${call.id.split('/')[2]}.ts`, 12 + 60 * index, `Null crash ${index}`)
          )
        }),
        // The earlier job is the slow one, so no order of arrival can decide the original.
        delay: (call) => (call.id === 'find/r1/0/correctness' ? 30 : 0)
      })
      await runDiscoverV7Program(fixture.context, config({ lensIds: ['correctness'] }), task)
      return fixture.events
    }
    // One finding per file: nothing can repeat, so no check runs and votes follow the last finder.
    const apart = await run(1)
    expect(apart.some((event) => event.includes('/repeats'))).toBe(false)
    expect(firstAt(apart, 'start verify/')).toBeGreaterThan(at(apart, 'end find/r1/0/correctness'))
    // Two findings in one file: the check waits for every finder and every vote waits for it.
    const shared = await run(2)
    expect(at(shared, 'start find/r1/repeats')).toBeGreaterThan(
      at(shared, 'end find/r1/0/correctness')
    )
    expect(firstAt(shared, 'start verify/')).toBeGreaterThan(at(shared, 'end find/r1/repeats'))
  })

  it('records a repeat worded differently as a duplicate and never verifies it again', async () => {
    const fixture = host({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? { findings: [finding('src/reserve.ts', 16, 'reserve() does not await store.save()')] }
          : call.id === 'find/r1/1/security'
            ? { findings: [finding('src/reserve.ts', 20, 'Store save is not awaited in reserve')] }
            : undefined
    })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    expect(result.findings).toMatchObject([
      { id: 'r1-a0-correctness-0', status: 'confirmed' },
      { id: 'r1-a1-security-0', status: 'confirmed', duplicateOf: 'r1-a0-correctness-0' }
    ])
    expect(fixture.calls.filter((call) => call.id.startsWith('verify/'))).toHaveLength(3)
  })
})

describe('Discover revision 7 report', () => {
  // The repeat at 22 matches the original at 10; the report at 34 only resembles the repeat.
  const lines: Record<string, number> = {
    'find/r1/0/correctness': 10,
    'find/r1/0/security': 22,
    'find/r1/1/correctness': 34
  }
  const copies = (call: WorkflowProgramCall) => {
    const line = lines[call.id]
    return line
      ? { findings: [finding('src/a.ts', line, 'Double charge on retry submit')] }
      : undefined
  }
  const verdicts = (id: string) => vote(id === 'r1-a1-correctness-0' ? 'refuted' : 'real')

  it('verifies a report that only resembles a repeat on its own and keeps its verdict', async () => {
    const fixture = host({ find: copies, verify: verdicts })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    expect(
      firstCalls(fixture.calls)
        .filter((call) => call.id.startsWith('verify/'))
        .map((call) => call.id.split('/')[1])
    ).toEqual([...Array(3).fill('r1-a0-correctness-0'), ...Array(3).fill('r1-a1-correctness-0')])
    expect(result.findings).toEqual([
      { id: 'r1-a0-correctness-0', title: 'Double charge on retry submit', status: 'confirmed' },
      {
        id: 'r1-a0-security-0',
        title: 'Double charge on retry submit',
        status: 'confirmed',
        duplicateOf: 'r1-a0-correctness-0'
      },
      { id: 'r1-a1-correctness-0', title: 'Double charge on retry submit', status: 'refuted' }
    ])
    // Rank sees the repeat only as provenance of its original, with no verdict of its own.
    const rank = byId(fixture.calls, 'rank/final')
    expect(rank.dependencies.map((id) => id.split('/')[1])).toEqual(
      Array(3).fill('r1-a0-correctness-0')
    )
    expect(rank.prompt).toContain('r1-a0-security-0 (Security lens, gemini)')
    expect(rank.prompt).toContain('"id": "r1-a1-correctness-0"')
    expect(result.report).toMatchObject({ refutedIds: ['r1-a1-correctness-0'], unverifiedIds: [] })
    // Only what was verified is counted; the note never claims how many defects exist.
    expect(fixture.logs).toContain(
      'Verified 2 of 3 reported findings (1 repeat set aside): 1 confirmed, 1 refuted, 0 unverified.'
    )
  })

  it('writes the counts above the overview in code and keeps a leading heading on top', () => {
    const item = (rank: number): DiscoverV7ReportItem => ({
      rank,
      title: `Defect ${rank}`,
      location: 'src/a.ts:10',
      severity: 'high',
      scenario: 'Charged twice',
      fix: 'Idempotency key',
      findingIds: [`r1-a${rank}-correctness-0`],
      parallelSafe: true
    })
    const items = Array.from({ length: 12 }, (_, index) => item(index + 1))
    const counts = { confirmed: 14, refuted: 0, unverified: 2 }
    expect(
      discoverV7RankedSummary(
        { summary: '## Overview\n\nFix the export path first.', items },
        counts
      )
    ).toBe(
      '## Overview\n\n14 confirmed findings in 12 ranked items; 0 refuted, 2 unverified.\n\nFix the export path first.'
    )
    expect(
      discoverV7RankedSummary(
        { summary: '  Fix the export path first.\n', items: [item(1)] },
        { confirmed: 1, refuted: 1, unverified: 0 }
      )
    ).toBe(
      '1 confirmed finding in 1 ranked item; 1 refuted, 0 unverified.\n\nFix the export path first.'
    )
  })

  it("replaces the ranker's refuted and unverified lists instead of failing the run", async () => {
    const fixture = host({
      find: copies,
      verify: verdicts,
      rank: ([id]) => ({
        summary: 'Fix the double charge.',
        items: [
          {
            rank: 1,
            title: 'Double charge',
            location: 'src/a.ts:10',
            severity: 'high',
            scenario: 'Charged twice',
            fix: 'Idempotency key',
            findingIds: [id],
            parallelSafe: true
          }
        ],
        refutedIds: ['r1-a0-security-0', id],
        unverifiedIds: ['r9-a9-invented-0']
      })
    })
    const result = await runDiscoverV7Program(fixture.context, config(), task)
    expect(invocations(fixture.calls, 'rank/final')).toBe(1)
    expect(result.report).toMatchObject({
      summary:
        '1 confirmed finding in 1 ranked item; 1 refuted, 0 unverified.\n\nFix the double charge.',
      refutedIds: ['r1-a1-correctness-0'],
      unverifiedIds: []
    })
  })
})

describe('Discover revision 7 agent estimate', () => {
  const lensIds = ['correctness', 'security', 'reliability']
  const mapped = (count: number) => ({
    areas: Array.from({ length: count }, (_, index) => ({
      name: `Area ${index + 1}`,
      files: [`src/area-${index}.ts`],
      why: 'Handles money'
    }))
  })
  /** Each finder reports `count(call, limit)` new defects; `limit` is what its prompt allows. */
  const reporting =
    (count: (call: WorkflowProgramCall, limit: number) => number) =>
    (call: WorkflowProgramCall) => {
      const limit = Number(/Report at most (\d+) defect/.exec(call.prompt)?.[1])
      return {
        findings: Array.from({ length: count(call, limit) }, (_, index) =>
          finding(
            `src/${call.id.replaceAll('/', '-')}.ts`,
            100 * (index + 1),
            `Null crash ${index}`
          )
        )
      }
    }
  const filling = reporting((_, limit) => limit)

  it('uses exactly the low estimate when the scout returns no map and nothing is found', async () => {
    for (const depth of ['quick', 'exhaustive'] as const) {
      const fixture = host({ scout: () => new Error('scout timed out') })
      await runDiscoverV7Program(fixture.context, config({ depth, lensIds }), task)
      // Calls, not attempts: the scout was tried three times.
      expect(firstCalls(fixture.calls)).toHaveLength(estimateDiscoverAgents(3, depth, 160).low)
    }
  })

  it('reaches the high estimate at Quick when every finder fills its limit', async () => {
    const fixture = host({ scout: () => mapped(8), find: filling })
    const result = await runDiscoverV7Program(fixture.context, config({ lensIds }), task)
    // The scout, 24 finder jobs, their repeat check, 44 findings' votes and Rank. Each job may
    // report 8, but the round can verify 44 in all: the rest are set aside and logged.
    expect(invocations(fixture.calls, 'find/r1/repeats')).toBe(1)
    expect(fixture.calls).toHaveLength(159)
    expect(estimateDiscoverAgents(3, 'quick', 160)).toMatchObject({ high: 159, capped: true })
    expect(
      result.dropped.some((line) =>
        line.startsWith(
          'Round 1: set aside 148 findings beyond what the round could verify within 160 agents (Area 1 · Correctness: 6;'
        )
      )
    ).toBe(true)
  })

  it('counts runs that find a little less in round 1 and so fit another round', async () => {
    const fill = host({ scout: () => mapped(8), find: filling })
    await runDiscoverV7Program(fill.context, config({ depth: 'thorough', lensIds }), task)
    expect(fill.calls).toHaveLength(159)
    // Round 1 can verify 44 findings. Six jobs report one and the rest two: 42 in all, the four
    // past their jobs' shares taking votes other jobs left. That leaves seven free calls: one
    // more finder job with two findings, and no call left for a repeat check, so both of them
    // are verified.
    const short = host({
      scout: () => mapped(8),
      find: reporting((call, limit) =>
        Math.min(limit, /^find\/r1\/[0-5]\/security$/.test(call.id) ? 1 : 2)
      )
    })
    const result = await runDiscoverV7Program(
      short.context,
      config({ depth: 'thorough', lensIds }),
      task
    )
    expect(short.logs).toContain(
      'Round 1: 4 more findings get the votes other finder jobs did not need.'
    )
    expect(short.calls.filter((call) => call.id.startsWith('find/r2/'))).toHaveLength(1)
    expect(result.dropped).toContain(
      'Round 2: no agent was left to check 2 new findings for repeats, so each one is verified.'
    )
    expect(short.calls).toHaveLength(160)
    expect(estimateDiscoverAgents(3, 'thorough', 160).high).toBe(160)
  })
})
