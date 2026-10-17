import { describe, expect, it } from 'vitest'
import { DISCOVER_MIN_AGENTS } from '../../../../shared/local-workflow-draft'
import type { WorkflowProgramCall } from '../workflow-program-context'
import { runDiscoverV7Program } from './discover-v7'
import type { DiscoverV7Batch, DiscoverV7Vote } from './discover-v7-plan'
import {
  byId,
  config,
  finding,
  firstCalls,
  host,
  invocations,
  task,
  vote,
  type Responder
} from './discover-v7.test-fixtures'

describe('Discover revision 7 program', () => {
  it('scouts, finds per area and lens, dedups in code and verifies fresh findings across families', async () => {
    const batches: Record<string, Partial<DiscoverV7Batch> | Error> = {
      'find/r1/0/correctness': {
        findings: [finding('src/a.ts', 12, 'Null crash'), finding('src/a.ts', 40, 'Lost update')]
      },
      'find/r1/0/security': {
        findings: [finding('./src/a.ts', 15, 'Null  crash!'), finding('src/b.ts', 3, 'Token leak')]
      },
      'find/r1/1/correctness': new Error('finder timed out'),
      'find/r1/1/security': { findings: [finding('src/c.ts', 7, 'Double charge')] }
    }
    // Votes per finding in lens order: correctness, reachability, reproduction.
    const ballots: Record<string, (DiscoverV7Vote['verdict'] | 'error')[]> = {
      'r1-a0-correctness-0': ['real', 'real', 'refuted'],
      'r1-a0-correctness-1': ['refuted', 'refuted', 'real'],
      'r1-a0-security-1': ['real', 'error', 'unjudged'],
      'r1-a1-security-0': ['refuted', 'error', 'error']
    }
    const lenses = ['correctness', 'reachability', 'reproduction']
    const fixture = host({
      find: (call) => batches[call.id],
      verify: (id, lens) => {
        const verdict = ballots[id][lenses.indexOf(lens)]
        return verdict === 'error' ? new Error('verifier crashed') : vote(verdict)
      }
    })
    const result = await runDiscoverV7Program(fixture.context, config(), task)

    expect(fixture.phases).toEqual(['Scout', 'Find', 'Verify', 'Rank'])
    const scout = byId(fixture.calls, 'scout/map')
    expect(scout).toMatchObject({ seatId: 'claude', timeoutMs: 600_000 })
    expect(scout.prompt).toContain('Focus (workspace-relative):\n- src')
    expect(scout.prompt).toContain('Find real bugs in the checkout flow')

    const calls = firstCalls(fixture.calls)
    const finds = calls.filter((call) => /^find\/r\d+\/\d+\//.test(call.id))
    expect(finds.map((call) => [call.id, call.seatId])).toEqual([
      ['find/r1/0/correctness', 'grok'],
      ['find/r1/0/security', 'gemini'],
      ['find/r1/1/correctness', 'gemini'],
      ['find/r1/1/security', 'codex']
    ])
    // Failed calls run until their three persisted attempts are spent, so their null is final.
    expect(invocations(fixture.calls, 'find/r1/1/correctness')).toBe(3)
    expect(invocations(fixture.calls, 'verify/r1-a1-security-0/reachability')).toBe(3)
    expect(invocations(fixture.calls, 'verify/r1-a0-correctness-0/correctness')).toBe(1)
    for (const call of finds) {
      expect(call.timeoutMs).toBe(1_200_000)
      expect(call.prompt).toContain(
        'Read those files completely. Trace the actual control flow. Report only defects you can point at in code with file:line and a concrete failure scenario. Be adversarial: assume every guard has a hole and go find it. Do not report style issues.'
      )
      expect(call.prompt).not.toContain('Already known')
      expect(call.prompt).toContain('read-only tools')
    }
    expect(byId(fixture.calls, 'find/r1/0/correctness').prompt).toContain('YOUR AREA: Checkout')
    expect(byId(fixture.calls, 'find/r1/1/security').prompt).toContain('LENS: Security:')

    const verifies = calls.filter((call) => call.id.startsWith('verify/'))
    expect(verifies).toHaveLength(12)
    expect(verifies.some((call) => call.seatId === 'gemini')).toBe(false)
    expect(verifies.some((call) => call.id.includes('r1-a0-security-0'))).toBe(false)
    const verifiers = (id: string) =>
      ['correctness', 'reachability', 'reproduction'].map(
        (lens) => byId(fixture.calls, `verify/${id}/${lens}`).seatId
      )
    expect(verifiers('r1-a0-correctness-0')).toEqual(['codex', 'claude', 'codex'])
    expect(verifiers('r1-a0-correctness-1')).toEqual(['claude', 'codex', 'claude'])
    expect(verifiers('r1-a0-security-1')).toEqual(['claude', 'codex', 'grok'])
    expect(verifiers('r1-a1-security-0')).toEqual(['grok', 'claude', 'grok'])
    for (const call of verifies) {
      expect(call.timeoutMs).toBe(600_000)
      expect(call.prompt).toContain('Your job is to REFUTE this reported defect if you can.')
    }

    const rank = byId(fixture.calls, 'rank/final')
    expect(rank).toMatchObject({ seatId: 'claude', timeoutMs: 600_000 })
    expect(rank.dependencies).toEqual([
      'verify/r1-a0-correctness-0/correctness',
      'verify/r1-a0-correctness-0/reachability',
      'verify/r1-a0-correctness-0/reproduction'
    ])
    // The duplicate found through the security lens reaches the ranker as provenance.
    expect(rank.prompt).toContain('r1-a0-security-0 (Security lens, gemini)')
    // Two new findings share src/a.ts, so the ranker groups all four new ones before any vote.
    const repeats = byId(fixture.calls, 'find/r1/repeats')
    expect(repeats).toMatchObject({ seatId: 'claude', timeoutMs: 600_000 })
    expect(repeats.dependencies).toEqual(finds.map((call) => call.id))
    expect([...repeats.prompt.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1])).toEqual([
      'r1-a0-correctness-0',
      'r1-a0-correctness-1',
      'r1-a0-security-1',
      'r1-a1-security-0'
    ])
    expect(repeats.prompt).toContain('the same violated condition')
    expect(fixture.events.indexOf('end find/r1/repeats')).toBeLessThan(
      fixture.events.findIndex((event) => event.startsWith('start verify/'))
    )
    expect(fixture.logs).toContain(
      'Round 1: the repeat check found no repeats among 4 new findings.'
    )
    expect(fixture.logs).toContain(
      'Verified 4 of 5 reported findings (1 repeat set aside): 1 confirmed, 1 refuted, 2 unverified.'
    )
    expect(calls).toHaveLength(19)
    expect(fixture.calls).toHaveLength(27)
    expect(result.findings).toEqual([
      { id: 'r1-a0-correctness-0', title: 'Null crash', status: 'confirmed' },
      { id: 'r1-a0-correctness-1', title: 'Lost update', status: 'refuted' },
      {
        id: 'r1-a0-security-0',
        title: 'Null  crash!',
        status: 'confirmed',
        duplicateOf: 'r1-a0-correctness-0'
      },
      { id: 'r1-a0-security-1', title: 'Token leak', status: 'unverified' },
      { id: 'r1-a1-security-0', title: 'Double charge', status: 'unverified' }
    ])
    expect(result.report.items.map((item) => item.findingIds)).toEqual([['r1-a0-correctness-0']])
    // The ranker is told the exact counts and not to restate them; code writes them on top.
    expect(rank.prompt).toContain('The 1 confirmed finding survived verification')
    expect(rank.prompt).toContain('1 refuted and 2 unverified findings are listed after them.')
    expect(rank.prompt).toContain('Do not state how many findings, defects or items there are')
    expect(result.report.summary).toBe(
      '1 confirmed finding in 1 ranked item; 1 refuted, 2 unverified.\n\nFix the double charge first.'
    )
    expect(result.dropped).toEqual([])
  })

  it('makes the same calls and decisions whatever order finders finish in', async () => {
    const find = (call: WorkflowProgramCall) =>
      call.id === 'find/r1/0/correctness'
        ? { findings: [finding('src/a.ts', 12, 'Null crash')] }
        : call.id === 'find/r1/1/security'
          ? {
              findings: [
                finding('src/a.ts', 18, 'Null crash'),
                finding('src/d.ts', 2, 'Token leak')
              ]
            }
          : undefined
    const jobs = [
      'find/r1/0/correctness',
      'find/r1/0/security',
      'find/r1/1/correctness',
      'find/r1/1/security'
    ]
    const forward = host({ find, delay: (call) => Math.max(0, jobs.indexOf(call.id)) * 3 })
    const backward = host({
      find,
      delay: (call) => (jobs.includes(call.id) ? (3 - jobs.indexOf(call.id)) * 3 : 0)
    })
    const first = await runDiscoverV7Program(forward.context, config(), task)
    const second = await runDiscoverV7Program(backward.context, config(), task)
    const shape = (calls: WorkflowProgramCall[]) =>
      calls.map((call) => JSON.stringify([call.id, call.seatId, call.prompt])).sort()
    expect(shape(backward.calls)).toEqual(shape(forward.calls))
    expect(second).toEqual(first)
    expect(first.findings.find((entry) => entry.id === 'r1-a1-security-0')).toMatchObject({
      duplicateOf: 'r1-a0-correctness-0'
    })
  })

  it('loops until a dry round at thorough depth and tells finders what is already known', async () => {
    const fixture = host({
      find: (call) =>
        call.id.endsWith('/0/correctness')
          ? { findings: [finding('src/a.ts', 12, 'Null crash')] }
          : undefined
    })
    const result = await runDiscoverV7Program(
      fixture.context,
      config({ depth: 'thorough', lensIds: ['correctness'] }),
      task
    )
    expect(
      fixture.calls.filter((call) => call.id.startsWith('find/')).map((call) => call.id)
    ).toEqual([
      'find/r1/0/correctness',
      'find/r1/1/correctness',
      'find/r2/0/correctness',
      'find/r2/1/correctness'
    ])
    expect(byId(fixture.calls, 'find/r2/1/correctness').prompt).toContain(
      'Already known (do not report again):\n- src/a.ts:12 Null crash'
    )
    expect(byId(fixture.calls, 'find/r2/0/correctness').seatId).toBe('gemini')
    expect(result.findings.map((entry) => [entry.id, entry.duplicateOf])).toEqual([
      ['r1-a0-correctness-0', undefined],
      ['r2-a0-correctness-0', 'r1-a0-correctness-0']
    ])
    expect(fixture.calls.filter((call) => call.id.startsWith('verify/'))).toHaveLength(3)
  })

  it('needs two dry rounds in a row at exhaustive depth', async () => {
    const fixture = host({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? { findings: [finding('src/a.ts', 12, 'Null crash')] }
          : undefined
    })
    await runDiscoverV7Program(
      fixture.context,
      config({ depth: 'exhaustive', lensIds: ['correctness'] }),
      task
    )
    const rounds = new Set(
      fixture.calls
        .filter((call) => call.id.startsWith('find/'))
        .map((call) => call.id.split('/')[1])
    )
    expect([...rounds]).toEqual(['r1', 'r2', 'r3'])
  })

  it('logs the depth limit when the last allowed round still finds new defects', async () => {
    const fixture = host({
      find: (call) => {
        const round = Number(call.id.split('/')[1].slice(1))
        return call.id.endsWith('/0/correctness')
          ? { findings: [finding('src/a.ts', round * 100, `Stale total in round ${round}`)] }
          : undefined
      }
    })
    const result = await runDiscoverV7Program(
      fixture.context,
      config({ depth: 'thorough', lensIds: ['correctness'] }),
      task
    )
    const message = 'Stopped at the Thorough limit of 3 rounds; round 3 still found 1 new finding.'
    expect(result.dropped).toEqual([message])
    expect(fixture.logs).toContain(message)
    expect(fixture.calls.some((call) => call.id.startsWith('find/r4/'))).toBe(false)
  })

  it('never starts finder work the budget cannot verify, gives unused votes to further findings and logs every drop', async () => {
    const fixture = host({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? {
              findings: [
                finding('src/a.ts', 10, 'Null crash'),
                finding('src/a.ts', 30, 'Lost update'),
                finding('src/a.ts', 50, 'Stale total')
              ]
            }
          : { findings: [], omitted: 3 }
    })
    const result = await runDiscoverV7Program(fixture.context, config({ maxAgents: 10 }), task)
    // The cap keeps every area's first lens before any area's second lens. Each kept job keeps
    // votes for one finding and may report two: the round can verify two findings in all.
    const dropped = [
      'Round 1: skipped 2 of 4 finder jobs to stay within 10 agents (Checkout · Security; Payments · Security).',
      'Round 1: 2 new findings can get their 3 votes within 10 agents, so each finder job keeps votes for 1 finding; a job may report up to 2, and findings past its share get the votes other jobs leave unused.',
      'Round 1, Checkout · Correctness: the finder left out 1 more finding beyond its limit of 2.',
      'Round 1, Payments · Correctness: the finder left out 3 more findings beyond its limit of 2.',
      'Round 1: no agent was left to check 2 new findings for repeats, so each one is verified.'
    ]
    expect(result.dropped).toEqual(dropped)
    for (const line of dropped) {
      expect(fixture.logs).toContain(line)
    }
    // Payments found nothing, so its kept votes verify the second Checkout finding.
    expect(fixture.logs).toContain(
      'Round 1: 1 more finding gets the votes other finder jobs did not need.'
    )
    expect(byId(fixture.calls, 'find/r1/0/correctness').prompt).toContain(
      'Report at most 2 defects,'
    )
    expect(fixture.calls.map((call) => call.id).filter((id) => !id.startsWith('verify/'))).toEqual([
      'scout/map',
      'find/r1/0/correctness',
      'find/r1/1/correctness',
      'rank/final'
    ])
    for (const id of ['r1-a0-correctness-0', 'r1-a0-correctness-1']) {
      expect(fixture.calls.filter((call) => call.id.startsWith(`verify/${id}/`))).toHaveLength(3)
    }
    // Every finding that was kept got all its votes; none is left unverified for want of agents.
    expect(result.findings).toEqual([
      { id: 'r1-a0-correctness-0', title: 'Null crash', status: 'confirmed' },
      { id: 'r1-a0-correctness-1', title: 'Lost update', status: 'confirmed' }
    ])
    expect(fixture.calls).toHaveLength(10)
  })

  it('searches, verifies and ranks within the smallest budget admission allows', async () => {
    const fixture = host({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? { findings: [finding('src/a.ts', 12, 'Null crash')] }
          : undefined
    })
    const result = await runDiscoverV7Program(
      fixture.context,
      config({ maxAgents: DISCOVER_MIN_AGENTS }),
      task
    )
    // One finder job fits: the scout, the finder, its three votes and the ranker.
    const ids = fixture.calls.map((call) => call.id)
    expect(ids).toHaveLength(DISCOVER_MIN_AGENTS)
    expect(ids.slice(0, 2)).toEqual(['scout/map', 'find/r1/0/correctness'])
    expect(ids.slice(2, 5).toSorted()).toEqual([
      'verify/r1-a0-correctness-0/correctness',
      'verify/r1-a0-correctness-0/reachability',
      'verify/r1-a0-correctness-0/reproduction'
    ])
    expect(ids.at(-1)).toBe('rank/final')
    expect(result.findings).toEqual([
      { id: 'r1-a0-correctness-0', title: 'Null crash', status: 'confirmed' }
    ])
    expect(result.report.items.map((item) => item.findingIds)).toEqual([['r1-a0-correctness-0']])
  })

  it('settles a failing finder before later rounds depend on what it found', async () => {
    let failures = 0
    const fixture = host({
      find: (call) => {
        if (call.id === 'find/r1/1/correctness' && failures < 2) {
          failures += 1
          return new Error('finder timed out')
        }
        return call.id === 'find/r1/0/correctness'
          ? { findings: [finding('src/a.ts', 12, 'Null crash')] }
          : call.id === 'find/r1/1/correctness'
            ? { findings: [finding('src/b.ts', 40, 'Token leak')] }
            : undefined
      }
    })
    await runDiscoverV7Program(
      fixture.context,
      config({ depth: 'thorough', lensIds: ['correctness'] }),
      task
    )
    expect(invocations(fixture.calls, 'find/r1/1/correctness')).toBe(3)
    for (const id of ['find/r2/0/correctness', 'find/r2/1/correctness']) {
      expect(byId(fixture.calls, id).prompt).toContain(
        'Already known (do not report again):\n- src/a.ts:12 Null crash\n- src/b.ts:40 Token leak'
      )
    }
  })

  it('names finders that returned nothing in the empty report', async () => {
    const fixture = host({
      find: (call) => (call.id === 'find/r1/1/correctness' ? new Error('timed out') : undefined)
    })
    const result = await runDiscoverV7Program(
      fixture.context,
      config({ lensIds: ['correctness'] }),
      task
    )
    expect(result.report.summary).toBe(
      'Discover found no defects in the areas it inspected. 1 of 2 finder jobs returned nothing, so part of the code was not searched.'
    )
    expect(fixture.logs).toContain(
      'Round 1: 0 reported, 0 new; 1 of 2 finder jobs returned nothing'
    )
  })

  it('fails the run instead of reporting a clean result when no finder answered', async () => {
    const fixture = host({ find: () => new Error('route unavailable') })
    await expect(
      runDiscoverV7Program(fixture.context, config({ lensIds: ['correctness'] }), task)
    ).rejects.toThrow(/could not search the code/)
    expect(invocations(fixture.calls, 'find/r1/0/correctness')).toBe(3)
    expect(fixture.calls.some((call) => call.id === 'rank/final')).toBe(false)
  })

  it('falls back to one area and attaches frozen evidence when the scout fails', async () => {
    const fixture = host({ scout: () => new Error('scout timed out') })
    const evidence = '--- src/a.ts ---\n1 | export const total = 1'
    const result = await runDiscoverV7Program(
      fixture.context,
      config({ access: 'frozen', focus: [] }),
      { prompt: task.prompt, evidence }
    )
    expect(invocations(fixture.calls, 'scout/map')).toBe(3)
    const finds = fixture.calls.filter((call) => call.id.startsWith('find/'))
    expect(finds.map((call) => call.id)).toEqual(['find/r1/0/correctness', 'find/r1/0/security'])
    for (const call of finds) {
      expect(call.prompt).toContain('YOUR AREA: Workspace')
      expect(call.prompt).toContain('You cannot read the workspace.')
      expect(call.prompt).toContain('The files are attached below.')
      expect(call.prompt).toContain(evidence)
    }
    expect(fixture.logs).toContain(
      'Scout did not return a map; searching the whole focus as one area.'
    )
    expect(fixture.calls.some((call) => call.id === 'rank/final')).toBe(false)
    expect(result.report).toEqual({
      summary: 'Discover found no defects in the areas it inspected.',
      items: [],
      refutedIds: [],
      unverifiedIds: []
    })
  })

  it('rejects a ranking that invents, drops or repeats confirmed findings, and nothing else', async () => {
    const responder = (rank: (confirmed: string[]) => unknown): Responder => ({
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? {
              findings: [
                finding('src/a.ts', 12, 'Null crash'),
                finding('src/a.ts', 90, 'Token leak')
              ]
            }
          : undefined,
      verify: (id) => vote(id === 'r1-a0-correctness-1' ? 'refuted' : 'real'),
      rank
    })
    const item = (findingIds: string[]) => ({
      rank: 1,
      title: 'Crash',
      location: 'src/a.ts:12',
      severity: 'high',
      scenario: 'Crash',
      fix: 'Guard',
      findingIds,
      parallelSafe: false
    })
    const report = (items: unknown[]) => () => ({
      summary: 'Summary',
      items,
      refutedIds: [],
      unverifiedIds: []
    })
    await expect(
      runDiscoverV7Program(
        host(responder(report([item(['r1-a0-correctness-0', 'r1-a0-correctness-1'])]))).context,
        config({ lensIds: ['correctness'] }),
        task
      )
    ).rejects.toThrow(/not a confirmed finding/)
    await expect(
      runDiscoverV7Program(
        host(responder(report([]))).context,
        config({ lensIds: ['correctness'] }),
        task
      )
    ).rejects.toThrow(/exactly one item/)
    await expect(
      runDiscoverV7Program(
        host(responder(report([item(['r1-a0-correctness-0']), item(['r1-a0-correctness-0'])])))
          .context,
        config({ lensIds: ['correctness'] }),
        task
      )
    ).rejects.toThrow(/exactly one item/)
    // Lists that contradict the votes are replaced by the votes' own lists, not rejected.
    const listed = await runDiscoverV7Program(
      host(
        responder(() => ({
          summary: 'Summary',
          items: [item(['r1-a0-correctness-0'])],
          refutedIds: ['r1-a0-correctness-0'],
          unverifiedIds: []
        }))
      ).context,
      config({ lensIds: ['correctness'] }),
      task
    )
    expect(listed.report).toMatchObject({
      refutedIds: ['r1-a0-correctness-1'],
      unverifiedIds: []
    })
  })

  it('stops instead of hanging when an earlier finder fails fatally', async () => {
    const fatal = new Error('fatal')
    const fixture = host({
      isFatal: (error) => error === fatal,
      delay: (call) => (call.id === 'find/r1/0/correctness' ? 10 : 0),
      find: (call) =>
        call.id === 'find/r1/0/correctness'
          ? fatal
          : { findings: [finding('src/b.ts', 4, 'Token leak')] }
    })
    await expect(runDiscoverV7Program(fixture.context, config(), task)).rejects.toBe(fatal)
  })

  it('refuses a Gemini ranker and unknown lenses', async () => {
    await expect(
      runDiscoverV7Program(host().context, config({ rankerId: 'gemini' }), task)
    ).rejects.toThrow(/non-Google ranker/)
    await expect(
      runDiscoverV7Program(host().context, config({ lensIds: ['style'] }), task)
    ).rejects.toThrow(/known lenses/)
    await expect(
      runDiscoverV7Program(host().context, config({ maxAgents: 401 }), task)
    ).rejects.toThrow(/1-400 agents/)
  })
})
