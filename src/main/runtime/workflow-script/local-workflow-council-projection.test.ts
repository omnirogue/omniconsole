import { describe, expect, it } from 'vitest'
import { modelLineage } from '../../../shared/model-lineage'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  councilResultMarkdown,
  councilStageDefinitions,
  projectCouncilEvidence,
  projectCouncilRun
} from './local-workflow-council-projection'
import { workflowCallSeatId } from './local-workflow-discover-projection'
import { councilSeatNames } from './presets/council-ranking'

const snapshot: LocalWorkflowHostSnapshot = {
  version: 1,
  task: { prompt: 'Compare', evidence: 'Frozen' },
  seats: (
    [
      ['a', 'claude', 'anthropic'],
      ['b', 'codex', 'openai'],
      ['c', 'grok', 'xai']
    ] as const
  ).map(([id, agent, lineage]) => ({
    id,
    agent,
    lineage,
    accountId: 'account',
    model: 'model',
    effort: null,
    policyRevision: 'test'
  })),
  synthesizerId: 'a',
  host: {
    workspaceId: 'workspace',
    conversationId: 'conversation',
    requestDigest: 'digest',
    startedAt: 1,
    concurrency: 3,
    sources: [],
    coverage: []
  }
}

function ballot(labels: string[]) {
  return {
    ranking: labels,
    assessments: labels.map((label) => ({ label, strengths: 'Supported', weaknesses: 'Uncertain' }))
  }
}

describe('Council durable projection', () => {
  it('shows accepted reviews without declaring a rank until all three ballots are present', () => {
    const results = new Map<string, unknown>([['peer/a', ballot(['Response B', 'Response C'])]])
    expect(projectCouncilEvidence(snapshot, results)).toMatchObject({
      reviews: [{ reviewer: 'Claude', ranking: ['Response B', 'Response C'] }],
      ranking: []
    })
    results.set('peer/b', ballot(['Response C', 'Response A']))
    results.set('peer/c', ballot(['Response A', 'Response B']))
    expect(projectCouncilEvidence(snapshot, results).ranking).toEqual([
      { label: 'Response A', model: 'Claude', score: 0.5, votes: 2 },
      { label: 'Response B', model: 'Codex', score: 0.5, votes: 2 },
      { label: 'Response C', model: 'Grok', score: 0.5, votes: 2 }
    ])
  })

  it('refuses an invalid accepted ballot instead of showing it as peer evidence', () => {
    const results = new Map<string, unknown>([['peer/a', ballot(['Response A', 'Response B'])]])
    expect(() => projectCouncilEvidence(snapshot, results)).toThrow('invalid')
  })
})

const v6Seat = (id: string, agent: 'claude' | 'codex' | 'grok' | 'gemini', model: string) => ({
  id,
  agent,
  lineage: modelLineage(agent, model),
  accountId: 'account',
  model,
  effort: agent === 'gemini' ? null : 'high',
  policyRevision: 'test'
})
const v6: LocalWorkflowHostSnapshot = {
  ...snapshot,
  councilProgramRevision: 6,
  access: 'workspace-read',
  seats: [
    v6Seat('seat-1', 'claude', 'claude-opus-5'),
    v6Seat('seat-2', 'codex', 'gpt-5.6-sol'),
    v6Seat('seat-3', 'grok', 'grok-4.6-build'),
    v6Seat('seat-4', 'gemini', 'gemini-3.8-flash')
  ],
  synthesizerId: 'seat-1',
  council: { memberIds: ['seat-2', 'seat-1', 'seat-3', 'seat-4'] }
}
const text = (markdown: string) => ({ markdown })

describe('Council run projection (revision 6)', () => {
  it('lists members in frozen order with stable labels, voting rights and the chairman', () => {
    const run = projectCouncilRun(v6, new Map(), [])!
    expect(
      run.members.map((member) => [member.seatId, member.label, member.votes, member.answerCallId])
    ).toEqual([
      ['seat-2', 'Response A', true, 'answer/seat-2'],
      ['seat-1', 'Response B', true, 'answer/seat-1'],
      ['seat-3', 'Response C', true, 'answer/seat-3'],
      ['seat-4', 'Response D', false, 'answer/seat-4']
    ])
    expect(run.members[0]).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      modelLabel: 'GPT-5.6 Sol',
      effort: 'high'
    })
    expect(run.chair).toEqual({
      seatId: 'seat-1',
      agent: 'claude',
      model: 'claude-opus-5',
      modelLabel: 'Claude Opus 5',
      effort: 'high'
    })
    expect(run).toMatchObject({ ballots: [], standings: [], selfVotesExcluded: true })
  })

  it('re-parses accepted ballots and scores them without self-votes', () => {
    const results = new Map<string, unknown>([
      ['answer/seat-2', text('A')],
      ['answer/seat-1', text('B')],
      ['answer/seat-4', text('D')],
      ['rank/seat-2', text('Fine.\n\nFINAL RANKING:\n1. Response A\n2. Response D\n3. Response B')],
      [
        'rank/seat-1',
        text('FINAL RANKING:\n1. **Response D**\n2. **Response A**\n3. **Response C**')
      ]
    ])
    const run = projectCouncilRun(v6, results, [])!
    expect(run.ballots).toEqual([
      {
        reviewerSeatId: 'seat-2',
        callId: 'rank/seat-2',
        evaluation: 'Fine.\n\nFINAL RANKING:\n1. Response A\n2. Response D\n3. Response B',
        ranking: ['Response A', 'Response D', 'Response B']
      },
      {
        reviewerSeatId: 'seat-1',
        callId: 'rank/seat-1',
        evaluation: 'FINAL RANKING:\n1. **Response D**\n2. **Response A**\n3. **Response C**',
        // Response C never answered, so a reviewer could not have been shown it.
        ranking: ['Response D', 'Response A']
      }
    ])
    // A (seat-2): only seat-1 counts, 2nd. B (seat-1): only seat-2 counts, 3rd. D: 2nd and 1st.
    expect(run.standings).toEqual([
      { label: 'Response D', seatId: 'seat-4', averageRank: 1.5, votes: 2, place: 1 },
      { label: 'Response A', seatId: 'seat-2', averageRank: 2, votes: 1, place: 2 },
      { label: 'Response B', seatId: 'seat-1', averageRank: 3, votes: 1, place: 3 }
    ])
  })

  it('skips malformed ballots instead of failing the view', () => {
    const results = new Map<string, unknown>([
      ['answer/seat-2', text('A')],
      ['rank/seat-2', { ranking: ['Response A'] }],
      ['rank/seat-1', text('   ')],
      ['rank/seat-4', text('FINAL RANKING:\n1. Response A')]
    ])
    expect(() => projectCouncilRun(v6, results, [])).not.toThrow()
    const run = projectCouncilRun(v6, results, [])!
    expect(run.ballots).toEqual([])
    expect(run.standings).toEqual([])
  })

  it('numbers a repeated model as the program does, for the members and the chairman', () => {
    const twin = { ...v6Seat('seat-5', 'claude', 'claude-opus-5'), effort: 'low' }
    const repeated: LocalWorkflowHostSnapshot = {
      ...v6,
      seats: [...v6.seats, twin],
      synthesizerId: 'seat-5',
      council: { memberIds: ['seat-1', 'seat-2', 'seat-5'] }
    }
    const run = projectCouncilRun(repeated, new Map(), [])!
    expect(run.members.map((member) => member.modelLabel)).toEqual([
      'Claude Opus 5 (1)',
      'GPT-5.6 Sol',
      'Claude Opus 5 (2)'
    ])
    expect(run.members.map((member) => member.modelLabel)).toEqual(
      councilSeatNames([repeated.seats[0], repeated.seats[1], twin])
    )
    expect(run.chair).toMatchObject({ seatId: 'seat-5', modelLabel: 'Claude Opus 5 (2)' })
    // A chairman outside the council keeps the plain model name.
    const outside = projectCouncilRun(
      { ...repeated, council: { memberIds: ['seat-1', 'seat-2'] } },
      new Map(),
      []
    )!
    expect(outside.members.map((member) => member.modelLabel)).toEqual([
      'Claude Opus 5',
      'GPT-5.6 Sol'
    ])
    expect(outside.chair?.modelLabel).toBe('Claude Opus 5')
  })

  it('attributes every revision 6 call to its seat', () => {
    expect(
      ['answer/seat-4', 'rank/seat-3', 'chair/final'].map((id) => workflowCallSeatId(v6, id))
    ).toEqual(['seat-4', 'seat-3', 'seat-1'])
  })

  it('defines the rail from the frozen roster and publishes the chairman answer', () => {
    expect(councilStageDefinitions(v6, new Map())).toEqual([
      { id: 'answer', label: 'First opinions', total: 4 },
      { id: 'rank', label: 'Peer rankings', total: 3 },
      { id: 'chair', label: "Chairman's answer", total: 1 }
    ])
    expect(councilResultMarkdown(v6, new Map([['synthesis/final', text('old')]]))).toBeUndefined()
    expect(councilResultMarkdown(v6, new Map([['chair/final', text('Use Redis.')]]))).toBe(
      'Use Redis.'
    )
  })
})

describe('Council run projection (legacy revisions)', () => {
  it('maps three seats, structured ballots and the old aggregate into the shared shape', () => {
    const results = new Map<string, unknown>([
      ['peer/a', ballot(['Response B', 'Response C'])],
      ['peer/b', ballot(['Response A', 'Response C'])],
      ['peer/c', ballot(['Response A', 'Response B'])]
    ])
    const run = projectCouncilRun({ ...snapshot, councilProgramRevision: 4 }, results, [])!
    expect(run.members.map((member) => [member.label, member.votes, member.answerCallId])).toEqual([
      ['Response A', true, 'answers/a'],
      ['Response B', true, 'answers/b'],
      ['Response C', true, 'answers/c']
    ])
    expect(run.chair?.seatId).toBe('a')
    expect(run.ballots[0]).toEqual({
      reviewerSeatId: 'a',
      callId: 'peer/a',
      evaluation: [
        '#### Response B',
        '',
        '**Strengths:** Supported',
        '',
        '**Weaknesses:** Uncertain',
        '',
        '#### Response C',
        '',
        '**Strengths:** Supported',
        '',
        '**Weaknesses:** Uncertain',
        '',
        'FINAL RANKING:',
        '1. Response B',
        '2. Response C'
      ].join('\n'),
      ranking: ['Response B', 'Response C']
    })
    // Old 0-based means: A 0, B 0.5, C 1, shown on the 1-based scale.
    expect(run.standings).toEqual([
      { label: 'Response A', seatId: 'a', averageRank: 1, votes: 2, place: 1 },
      { label: 'Response B', seatId: 'b', averageRank: 1.5, votes: 2, place: 2 },
      { label: 'Response C', seatId: 'c', averageRank: 2, votes: 2, place: 3 }
    ])
    expect(run.selfVotesExcluded).toBe(true)
  })

  it('shows valid legacy ballots, skips invalid ones and withholds an incomplete aggregate', () => {
    const results = new Map<string, unknown>([
      ['peer/a', ballot(['Response A', 'Response B'])],
      ['peer/b', ballot(['Response A', 'Response C'])]
    ])
    const run = projectCouncilRun(snapshot, results, [])!
    expect(run.ballots.map((entry) => entry.reviewerSeatId)).toEqual(['b'])
    expect(run.standings).toEqual([])
    expect(councilStageDefinitions(snapshot, results).map((stage) => stage.id)).toEqual([
      'answers',
      'peer',
      'synthesis'
    ])
    expect(
      councilResultMarkdown(snapshot, new Map([['synthesis/final', { markdown: 'Done' }]]))
    ).toBe('Done')
  })
})
