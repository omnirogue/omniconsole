import { describe, expect, it } from 'vitest'
import { validateJsonSchema } from '../../../../shared/json-schema-validate'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import { runDiscoverProgram, type DiscoverConfig } from './discover'
import { createLocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import {
  assessDiscoverVotes,
  selectDiscoverFindings,
  validateDiscoverRanking,
  type Finding,
  type FindingBatch
} from './discover-assessment'

const config: DiscoverConfig = {
  finder: { id: 'finder', lineage: 'openai' },
  skeptics: [
    { id: 'skeptic-a', lineage: 'anthropic' },
    { id: 'skeptic-b', lineage: 'xai' }
  ],
  synthesizer: { id: 'skeptic-a', lineage: 'anthropic' },
  dimensions: ['correctness', 'reliability', 'security'],
  lenses: ['occurrence', 'impact'],
  minimumSeverity: 'low',
  maxCandidates: 12
}
const finding = (location: string): Finding => ({
  issueKey: 'missing-check',
  title: 'Missing check',
  location,
  trigger: 'null input',
  impact: 'crash',
  severity: 'high',
  evidence: [{ ref: location, description: 'unguarded access' }]
})
const vote = (refuted: boolean, uncertain = false) => ({
  refuted,
  uncertain,
  reason: 'fixture evidence',
  evidence: []
})

function host(
  options: { empty?: boolean; refuted?: boolean; failOne?: boolean; badRanking?: boolean } = {}
) {
  const calls: WorkflowProgramCall[] = []
  const context = createWorkflowProgramContext({
    guard: () => {},
    isFatal: () => false,
    phase: () => {},
    log: () => {},
    agent: async (call) => {
      calls.push(call)
      let value: unknown
      if (call.id.startsWith('discover/')) {
        value = {
          findings: options.empty
            ? []
            : Array.from({ length: 4 }, (_, index) => finding(`${call.id}/${index}.ts`)),
          omittedCount: 0,
          omissionReason: ''
        }
      } else if (call.id.startsWith('refute/')) {
        if (options.failOne && calls.filter((item) => item.id.startsWith('refute/')).length === 1) {
          throw new Error('fixture provider failure')
        }
        value = vote(options.refuted ?? false)
      } else {
        const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1))
        value = {
          summary: 'Ranked fixture survivors',
          ranking: packet.survivors.map((item: { id: string }, index: number) => ({
            findingId: options.badRanking && index === 0 ? 'invented-id' : item.id,
            reason: 'Impact',
            nextAction: 'Inspect evidence'
          }))
        }
      }
      expect(validateJsonSchema(call.schema, value)).toEqual([])
      const error = call.validateSemantics(value)
      if (error) {
        throw new Error(error)
      }
      return value
    }
  })
  return { calls, context }
}

describe('Discover program', () => {
  it('settles 12 candidates with 24 distinct-lens calls and ranks exactly those survivors', async () => {
    const fixture = host()
    const result = await runDiscoverProgram(fixture.context, config, {
      prompt: 'Audit',
      evidence: 'Frozen fixture'
    })
    expect(fixture.calls).toHaveLength(28)
    expect(new Set(fixture.calls.map((call) => call.id)).size).toBe(28)
    expect(result.selection.selected).toHaveLength(12)
    expect(result.survivors).toHaveLength(12)
    const discoveryCalls = fixture.calls.filter((call) => call.id.startsWith('discover/'))
    expect(discoveryCalls.map((call) => call.seatId)).toEqual(['finder', 'finder', 'finder'])
    expect(discoveryCalls.every((call) => call.dependencies.length === 0)).toBe(true)
    expect(
      discoveryCalls.map(
        (call) => JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1)).context
      )
    ).toEqual(Array.from({ length: 3 }, () => ({ prompt: 'Audit', evidence: 'Frozen fixture' })))
    for (const candidate of result.selection.selected) {
      const reviews = fixture.calls.filter((call) => call.id.startsWith(`refute/${candidate.id}/`))
      expect(reviews.map((call) => call.seatId)).toEqual(['skeptic-a', 'skeptic-b'])
      expect(reviews.every((call) => call.prompt.includes('Default to refuted=true'))).toBe(true)
      expect(
        reviews.map((call) => {
          const packet = JSON.parse(call.prompt.slice(call.prompt.indexOf('\n') + 1))
          expect(Object.keys(packet).sort()).toEqual(['context', 'finding', 'lens'])
          expect(packet.finding.id).toBe(candidate.id)
          return packet.lens
        })
      ).toEqual(config.lenses)
    }
    const ranker = fixture.calls.at(-1)!
    expect(ranker.id).toBe('rank/final')
    expect(ranker.seatId).toBe('skeptic-a')
    const rankPacket = JSON.parse(ranker.prompt.slice(ranker.prompt.indexOf('\n') + 1))
    expect(rankPacket.survivors).toHaveLength(12)
    expect(
      rankPacket.survivors.every((item: { votes: unknown[] }) => item.votes.length === 2)
    ).toBe(true)
  })
  it('uses the two specified skeptical lenses by default', () => {
    const lenses = createLocalWorkflowDraft('discover').discover.lenses
    expect(lenses).toHaveLength(2)
    expect(lenses[0]).toContain('Correctness:')
    expect(lenses[1]).toContain('Actual occurrence:')
  })
  it('retains ordinary sibling work but blocks ranking on a missing verdict', async () => {
    const fixture = host({ failOne: true })
    await expect(
      runDiscoverProgram(fixture.context, config, { prompt: 'Audit', evidence: 'Frozen' })
    ).rejects.toThrow('required result missing')
    expect(fixture.calls).toHaveLength(27)
    expect(fixture.calls.some((call) => call.id === 'rank/final')).toBe(false)
  })
  it.each([{ empty: true }, { refuted: true }])(
    'does not manufacture an all-clear ranking for %j',
    async (options) => {
      const fixture = host(options)
      const result = await runDiscoverProgram(fixture.context, config, {
        prompt: 'Audit',
        evidence: 'Frozen'
      })
      expect(result.ranking).toBeNull()
      expect(fixture.calls).toHaveLength(options.empty ? 3 : 27)
    }
  )
  it('rejects ranker-invented IDs', async () => {
    const fixture = host({ badRanking: true })
    await expect(
      runDiscoverProgram(fixture.context, config, { prompt: 'Audit', evidence: 'Frozen' })
    ).rejects.toThrow('exactly')
  })
})

describe('Discover evidence rules', () => {
  it.each([
    [[vote(false), vote(false)], 'survives'],
    [[vote(false), vote(true)], 'contested'],
    [[vote(true), vote(false)], 'contested'],
    [[vote(true), vote(true)], 'refuted'],
    [[vote(true, true), vote(true)], 'refuted'],
    [[null, vote(false)], 'unresolved'],
    [[vote(false, true), vote(false)], 'unresolved']
  ] as const)('assesses %j as %s', (votes, outcome) => {
    expect(assessDiscoverVotes([...votes]).outcome).toBe(outcome)
  })
  it('labels uncertainty-based rejection as insufficient evidence', () => {
    expect(assessDiscoverVotes([vote(true, true), vote(true)]).disposition).toBe(
      'insufficient-evidence'
    )
  })
  it('merges only matching issue/location/trigger and preserves case-sensitive locations', () => {
    const batch = (findings: Finding[]): FindingBatch => ({
      findings,
      omittedCount: 0,
      omissionReason: ''
    })
    const result = selectDiscoverFindings(
      [
        batch([finding('A.ts'), finding('a.ts')]),
        batch([finding('A.ts')]),
        batch([finding('other.ts')])
      ],
      { ...config, finderId: 'finder', maxCandidates: 2 }
    )
    expect(result.found).toBe(4)
    expect(result.selected).toHaveLength(2)
    expect(result.excluded.map((item) => item.reason).sort()).toEqual(['duplicate', 'over-limit'])
  })
  it('rejects missing, duplicated and resurrected ranking IDs', () => {
    for (const ids of [[], ['a', 'a'], ['a', 'removed']]) {
      expect(
        validateDiscoverRanking({ ranking: ids.map((findingId) => ({ findingId })) }, [
          { id: 'a' },
          { id: 'b' }
        ])
      ).not.toBeNull()
    }
  })
})
