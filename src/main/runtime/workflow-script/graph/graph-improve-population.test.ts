import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from '../../../../shared/workflow-graph'
import { improveArchive, improveParents } from './graph-improve-archive'
import type { ImproveVersion } from './graph-improve-decide'
import {
  assertImproveReplaySupported,
  graphImprovePopulation,
  IMPROVE_RULES
} from './graph-improve-rules'
import type { GraphCall, GraphConfig } from './graph-plan'
import { drive, text } from './graph-test-harness'

function version(
  round: number,
  agentIndex: number,
  passing: number[] | undefined,
  total = 3
): ImproveVersion {
  return {
    text: {
      label: `v${round}-${agentIndex}`,
      markdown: `v${round}-${agentIndex}`,
      name: `n${agentIndex}`,
      seatId: 's',
      agentIndex,
      callId: `c${round}-${agentIndex}`
    },
    round,
    role: 'improve',
    ...(passing
      ? {
          check: {
            passed: passing.length === total,
            detail: '',
            cases: { total, passed: passing.length, unavailable: 0, passing }
          }
        }
      : {})
  }
}

const members = (archive: ReturnType<typeof improveArchive>) =>
  archive.map((member) => [member.version.text.callId, member.kept])

describe('improveArchive: the versions improvers build on', () => {
  const best = version(2, 0, [0, 1])

  it('keeps the best, plus versions that pass a case the best fails', () => {
    const pool = [version(1, 0, [0]), version(2, 1, [2]), version(2, 2, [1])]
    expect(members(improveArchive({ best, pool, population: 4 }))).toEqual([
      ['c2-0', 'best'],
      ['c2-1', 'cases']
    ])
  })

  it('keeps each further version only for a case no kept version passes yet', () => {
    const pool = [
      version(1, 1, [2], 5),
      version(1, 2, [3], 5),
      version(2, 1, [2, 3], 5),
      version(2, 2, [4], 5)
    ]
    const archive = improveArchive({ best: version(3, 0, [0, 1], 5), pool, population: 4 })
    // [2, 3] brings two new cases first; after it only case 4 is new, so [2] and [3] add nothing.
    expect(members(archive)).toEqual([
      ['c3-0', 'best'],
      ['c2-1', 'cases'],
      ['c2-2', 'cases']
    ])
  })

  it('breaks ties by the check, then by (round, improver), with no randomness', () => {
    const pool = [version(2, 2, [2]), version(2, 1, [2]), version(1, 2, [2])]
    expect(members(improveArchive({ best, pool, population: 2 }))).toEqual([
      ['c2-0', 'best'],
      ['c1-2', 'cases']
    ])
    const scored = { ...version(2, 2, [2]), check: { ...version(2, 2, [2]).check!, score: 9 } }
    expect(
      members(improveArchive({ best, pool: [version(1, 2, [2]), scored], population: 2 }))
    ).toEqual([
      ['c2-0', 'best'],
      ['c2-2', 'cases']
    ])
    const reversed = improveArchive({ best, pool: [...pool].toReversed(), population: 2 })
    expect(members(reversed)).toEqual([
      ['c2-0', 'best'],
      ['c1-2', 'cases']
    ])
  })

  it('falls back to the strongest alternative when no version qualifies', () => {
    const alternative = version(2, 2, [0])
    const archive = improveArchive({ best, pool: [alternative], alternative, population: 3 })
    expect(members(archive)).toEqual([
      ['c2-0', 'best'],
      ['c2-2', 'alternative']
    ])
    // Without a check nothing is measured, so the alternative is all there is.
    const plain = improveArchive({
      best: version(2, 0, undefined),
      pool: [version(2, 1, undefined)],
      alternative: version(2, 1, undefined),
      population: 3
    })
    expect(members(plain)).toEqual([
      ['c2-0', 'best'],
      ['c2-1', 'alternative']
    ])
  })

  it('never keeps "No change" beside the best, nor anything with one version to build on', () => {
    const unchanged = version(0, 0, [2])
    expect(members(improveArchive({ best, pool: [unchanged], population: 3 }))).toEqual([
      ['c2-0', 'best']
    ])
    expect(members(improveArchive({ best, pool: [version(2, 1, [2])], population: 1 }))).toEqual([
      ['c2-0', 'best']
    ])
  })

  it('assigns improver i to archive[i % k], and nobody a parent with one version', () => {
    const archive = improveArchive({ best, pool: [version(2, 1, [2])], population: 2 })
    const parents = improveParents({ best, archive }, 2, 5)
    expect(parents.map((parent) => parent?.version.text.callId)).toEqual([
      'c2-0',
      'c2-1',
      'c2-0',
      'c2-1',
      'c2-0'
    ])
    expect(improveParents({ best, archive }, 1, 3)).toEqual([undefined, undefined, undefined])
  })
})

function improve(agents: number, check: WorkflowCheck, population?: number): WorkflowSpec {
  return {
    version: 1,
    title: 'Improve',
    template: 'improve',
    steps: [
      {
        id: 'improve',
        kind: 'do',
        title: 'Improve',
        instruction: '',
        agents: Array.from({ length: agents }, () => ({ route: 'claude' as const })),
        inputs: []
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judge',
        instruction: '',
        agents: [{ route: 'codex' }],
        inputs: ['improve'],
        jev: { method: 'auto', only: true }
      }
    ],
    repeat: {
      do: 'improve',
      review: 'judge',
      until: 'plateau',
      maxRounds: 2,
      patience: 2,
      explore: 'low',
      check,
      ...(population ? { population } : {})
    }
  }
}

const RULES_2: Partial<GraphConfig> = {
  access: 'workspace-read',
  improveUnresolvedRounds: true,
  improveRules: IMPROVE_RULES
}
const RULES_1: Partial<GraphConfig> = { access: 'workspace-read', improveUnresolvedRounds: true }
const CASES: WorkflowCheck = { command: 'node t.mjs {case}', cases: ['a', 'b', 'c'] }

/** Round 1: improver 0 passes cases 0 and 1, improver 1 passes case 2 alone; later all pass 0 and 1. */
function answer(jevCandidates: string[][] = []) {
  return (call: GraphCall): unknown => {
    if (call.check) {
      const [round, agent] = (/^v(\d+)-(\d+)/.exec(call.check.candidate) ?? []).slice(1).map(Number)
      const passing = round === 1 ? (agent === 0 ? [0, 1] : agent === 1 ? [2] : [1]) : [0, 1]
      return {
        markdown: 'check',
        passed: false,
        detail: `v${round}-${agent}`,
        cases: { total: 3, passed: passing.length, unavailable: 0, passing }
      }
    }
    if (call.jev) {
      jevCandidates.push(call.jev.candidates.map((entry) => entry.markdown))
      return {
        markdown: `FINAL RANKING:\n${call.jev.candidates.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')}`
      }
    }
    return call.stepId === 'improve' ? text(`v${call.round}-${call.agentIndex}`) : undefined
  }
}

const improverPrompts = (plan: ReturnType<typeof drive>, round: number) =>
  plan.calls
    .filter((call) => call.stepId === 'improve' && call.round === round && !call.check)
    .map((call) => call.prompt)

describe('Improve rules 2: several versions to build on', () => {
  it('hands each improver its parent in turn, and names it on the trail', () => {
    const plan = drive(improve(3, CASES, 3), answer(), RULES_2)
    const [first, second, third] = improverPrompts(plan, 2)
    expect(first).toContain('The best version so far (by ')
    expect(first).toContain('v1-0')
    expect(second).toContain('The version you build on (by ')
    expect(second).toContain('v1-1')
    expect(second).toContain('passes practice cases the best version fails')
    expect(second).toContain('The version you build on FAILS it (1 of 3 cases pass)')
    expect(third).toContain('The best version so far (by ')
    const round2 = plan.loop!.improve!.rounds[1]!
    const parents = round2.candidates
      .filter((candidate) => candidate.role !== 'best')
      .map((candidate) => candidate.parent)
    expect(parents).toEqual([
      { round: 1, name: expect.any(String) },
      { round: 1, name: expect.any(String) },
      { round: 1, name: expect.any(String) }
    ])
    expect(round2.candidates.find((candidate) => candidate.role === 'best')?.parent).toBeUndefined()
  })

  it('judges at most 8 versions, never re-judging the kept ones', () => {
    const judged: string[][] = []
    const plan = drive(improve(7, CASES, 4), answer(judged), RULES_2)
    expect(plan.loop?.improve?.rounds).toHaveLength(2)
    expect(judged.length).toBeGreaterThan(0)
    for (const lineup of judged) {
      expect(lineup.length).toBeLessThanOrEqual(8)
    }
    const round2 = judged.at(-1)!
    // v1-1 passes case 2 that the best fails, so it is kept and built on, never judged again.
    expect(round2).not.toContain('v1-1')
    expect(round2.filter((markdown) => markdown.startsWith('v1-'))).toHaveLength(1)
    expect(improverPrompts(plan, 2)[1]).toContain('v1-1')
  })

  it('ignores the field below rules 2, and refuses such a saved run', () => {
    const without = drive(improve(3, CASES), answer(), RULES_2)
    const one = drive(improve(3, CASES, 1), answer(), RULES_2)
    expect(one.calls.map((call) => call.prompt)).toEqual(without.calls.map((call) => call.prompt))
    const oldRules = drive(improve(3, { command: 'npm test' }, 3), answer(), RULES_1)
    const oldPlain = drive(improve(3, { command: 'npm test' }), answer(), RULES_1)
    expect(oldRules.calls.map((call) => call.prompt)).toEqual(
      oldPlain.calls.map((call) => call.prompt)
    )
    expect(JSON.stringify(oldRules.loop)).toBe(JSON.stringify(oldPlain.loop))
    expect(graphImprovePopulation({ spec: improve(3, CASES, 3), improveRules: 1 })).toBe(1)
    expect(graphImprovePopulation({ spec: improve(3, CASES, 3), improveRules: 2 })).toBe(3)
    expect(() => assertImproveReplaySupported(improve(3, { command: 'x' }, 3), {})).toThrow(
      /versions to build on/
    )
    expect(() =>
      assertImproveReplaySupported(improve(3, { command: 'x' }, 3), { host: { improveRules: 2 } })
    ).not.toThrow()
  })
})
