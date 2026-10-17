import { describe, expect, it } from 'vitest'
import {
  councilMarkdown,
  councilMayRank,
  councilMemberLabel,
  councilNamedText,
  councilRankFromLegacyScore,
  councilStreetCred,
  parseCouncilRanking,
  placeCouncilStandings
} from './council-ranking'

const labels = ['Response A', 'Response B', 'Response C']

describe('Council ranking parser (karpathy parse_ranking_from_text)', () => {
  it('reads the numbered list after FINAL RANKING:', () => {
    const text = [
      'Response A is thorough. Response B is short. Response C is wrong.',
      '',
      'FINAL RANKING:',
      '1. Response C',
      '2. Response A',
      '3. Response B'
    ].join('\n')
    expect(parseCouncilRanking(text, labels)).toEqual(['Response C', 'Response A', 'Response B'])
  })

  it('falls back to any label after the marker when the list is not numbered', () => {
    const text = 'Response A first.\n\nFINAL RANKING:\n- Response B\n- **Response A**'
    expect(parseCouncilRanking(text, labels)).toEqual(['Response B', 'Response A'])
  })

  it('accepts emphasised labels in a numbered list, even when mixed with plain ones', () => {
    const text = 'FINAL RANKING:\n1. **Response B**\n2. **Response C**\n3. **Response A**'
    expect(parseCouncilRanking(text, labels)).toEqual(['Response B', 'Response C', 'Response A'])
    // The original regex would keep only "3. Response C" here.
    const mixed = 'FINAL RANKING:\n1. **Response B**\n2. _Response A_\n3. Response C'
    expect(parseCouncilRanking(mixed, labels)).toEqual(['Response B', 'Response A', 'Response C'])
  })

  it('falls back to every label in the text when the marker is missing', () => {
    expect(parseCouncilRanking('I prefer Response B over Response A.', labels)).toEqual([
      'Response B',
      'Response A'
    ])
  })

  it('reads the list under a loosely written ranking heading, not the discussion order', () => {
    // Discussed in the rotated order C, A, B; ranked B, C, A.
    const discussion = 'Response C is thorough. Response A is short. Response B is best.'
    for (const heading of [
      '**Final Ranking**:',
      '**Final Ranking:**',
      '## FINAL RANKING',
      'Final ranking (best to worst):'
    ]) {
      expect(
        parseCouncilRanking(
          `${discussion}\n\n${heading}\n1. Response B\n2. Response C\n3. Response A`,
          labels
        )
      ).toEqual(['Response B', 'Response C', 'Response A'])
    }
  })

  it('uses the last loose heading and ignores mid-sentence mentions', () => {
    const text = [
      'Final ranking:',
      '1. Response A is fine, more below.',
      '',
      '### Final Ranking',
      '1. Response C',
      '2. Response A'
    ].join('\n')
    expect(parseCouncilRanking(text, labels)).toEqual(['Response C', 'Response A'])
    // Not headings, so Karpathy's whole-text fallback applies.
    expect(
      parseCouncilRanking('Response C leads. My final ranking: Response B, Response A.', labels)
    ).toEqual(['Response C', 'Response B', 'Response A'])
    expect(
      parseCouncilRanking(
        'Response B leads.\nFinal ranking considerations: Response C, then Response A.',
        labels
      )
    ).toEqual(['Response B', 'Response C', 'Response A'])
  })

  it('does not fall back to the whole text once the marker is present', () => {
    expect(parseCouncilRanking('Response A is best.\nFINAL RANKING: none', labels)).toEqual([])
  })

  it('reads only the section between the first and second marker, as Karpathy splits', () => {
    const text = 'FINAL RANKING: format\n1. Response A\nFINAL RANKING:\n1. Response B'
    expect(parseCouncilRanking(text, labels)).toEqual(['Response A'])
  })

  it('deduplicates labels and drops responses the reviewer was not shown', () => {
    const text = 'FINAL RANKING:\n1. Response B\n2. Response B\n3. Response Z\n4. Response A'
    expect(parseCouncilRanking(text, labels)).toEqual(['Response B', 'Response A'])
    expect(parseCouncilRanking(text, ['Response A', 'Response C'])).toEqual(['Response A'])
  })

  it('returns nothing when no known label appears', () => {
    expect(parseCouncilRanking('All answers are fine.', labels)).toEqual([])
    expect(parseCouncilRanking('FINAL RANKING:\n1. Response Z', labels)).toEqual([])
  })
})

describe('Council street cred', () => {
  it('averages 1-based positions and never counts a member ranking its own answer', () => {
    const responses = labels.map((label, index) => ({ label, seatId: `seat-${index + 1}` }))
    const standings = councilStreetCred(responses, [
      { reviewerSeatId: 'seat-1', ranking: ['Response A', 'Response B', 'Response C'] },
      { reviewerSeatId: 'seat-2', ranking: ['Response B', 'Response C', 'Response A'] },
      { reviewerSeatId: 'seat-3', ranking: ['Response B', 'Response A', 'Response C'] }
    ])
    // A: seat-2 3rd, seat-3 2nd. B: seat-1 2nd, seat-3 1st. C: seat-1 3rd, seat-2 2nd.
    expect(standings).toEqual([
      { label: 'Response B', seatId: 'seat-2', averageRank: 1.5, votes: 2, place: 1 },
      { label: 'Response A', seatId: 'seat-1', averageRank: 2.5, votes: 2, place: 2 },
      { label: 'Response C', seatId: 'seat-3', averageRank: 2.5, votes: 2, place: 2 }
    ])
  })

  it('rounds to two decimals and lets ties share a place', () => {
    const responses = [
      { label: 'Response A', seatId: 'a' },
      { label: 'Response B', seatId: 'b' },
      { label: 'Response C', seatId: 'c' }
    ]
    const standings = councilStreetCred(responses, [
      { reviewerSeatId: 'x', ranking: ['Response A', 'Response B', 'Response C'] },
      { reviewerSeatId: 'y', ranking: ['Response B', 'Response A', 'Response C'] },
      { reviewerSeatId: 'z', ranking: ['Response A', 'Response B', 'Response C'] }
    ])
    expect(standings.map(({ label, averageRank, place }) => [label, averageRank, place])).toEqual([
      ['Response A', 1.33, 1],
      ['Response B', 1.67, 2],
      ['Response C', 3, 3]
    ])
    const tied = councilStreetCred(responses, [
      { reviewerSeatId: 'x', ranking: ['Response B', 'Response A', 'Response C'] },
      { reviewerSeatId: 'y', ranking: ['Response A', 'Response B', 'Response C'] }
    ])
    expect(tied.map(({ label, place }) => [label, place])).toEqual([
      ['Response A', 1],
      ['Response B', 1],
      ['Response C', 3]
    ])
  })

  it('lists responses nobody else ranked last with no votes', () => {
    const standings = councilStreetCred(
      [
        { label: 'Response A', seatId: 'a' },
        { label: 'Response B', seatId: 'b' }
      ],
      [{ reviewerSeatId: 'b', ranking: ['Response B', 'Response A'] }]
    )
    expect(standings).toEqual([
      { label: 'Response A', seatId: 'a', averageRank: 2, votes: 1, place: 1 },
      { label: 'Response B', seatId: 'b', averageRank: 0, votes: 0, place: 2 }
    ])
    expect(councilStreetCred([{ label: 'Response A', seatId: 'a' }], [])).toEqual([
      { label: 'Response A', seatId: 'a', averageRank: 0, votes: 0, place: 1 }
    ])
  })

  it('places precomputed legacy aggregates on the same 1-based scale', () => {
    expect(
      placeCouncilStandings(
        [0.5, 0, 1].map((score, index) => ({
          label: councilMemberLabel(index),
          seatId: `seat-${index}`,
          averageRank: councilRankFromLegacyScore(score),
          votes: 2
        }))
      ).map(({ label, averageRank, place }) => [label, averageRank, place])
    ).toEqual([
      ['Response B', 1, 1],
      ['Response A', 1.5, 2],
      ['Response C', 2, 3]
    ])
  })
})

describe('Council ranking helpers', () => {
  it('labels members in order and keeps Gemini and unknown families from judging', () => {
    expect([0, 1, 5].map(councilMemberLabel)).toEqual(['Response A', 'Response B', 'Response F'])
    expect(councilMayRank({ lineage: 'anthropic' })).toBe(true)
    expect(councilMayRank({ lineage: 'google' })).toBe(false)
    expect(councilMayRank({ lineage: 'unknown' })).toBe(false)
  })

  it('reads text results only when they carry non-blank markdown', () => {
    expect(councilMarkdown({ markdown: 'Answer' })).toBe('Answer')
    expect(councilMarkdown({ markdown: '  ' })).toBeUndefined()
    expect(councilMarkdown({ text: 'Answer' })).toBeUndefined()
    expect(councilMarkdown(null)).toBeUndefined()
  })

  it('names the members a reviewer wrote about by label, in prose, lists and the ranking', () => {
    const names = new Map([
      ['Response A', 'Claude Opus 5 (1)'],
      ['Response B', 'GPT-5.6 Sol'],
      ['Response D', 'Claude Opus 5 (2)']
    ])
    const named = (text: string) => councilNamedText(text, names)
    expect(named("Response A's cache is stale, which Response B misses.")).toBe(
      "Claude Opus 5 (1)'s cache is stale, which GPT-5.6 Sol misses."
    )
    expect(named('Responses A and B agree; Responses A, B, and D cite files.')).toBe(
      'Claude Opus 5 (1) and GPT-5.6 Sol agree; Claude Opus 5 (1), GPT-5.6 Sol, and Claude Opus 5 (2) cite files.'
    )
    expect(named('FINAL RANKING:\n1. Response D\n2. **Response B**\n3. Response A')).toBe(
      'FINAL RANKING:\n1. Claude Opus 5 (2)\n2. **GPT-5.6 Sol**\n3. Claude Opus 5 (1)'
    )
    expect(named('Response A, Response B & Response D')).toBe(
      'Claude Opus 5 (1), GPT-5.6 Sol & Claude Opus 5 (2)'
    )
    expect(
      named('Response A/B hedge; Response B vs. A, then Response D vs A and B versus D.')
    ).toBe(
      'Claude Opus 5 (1)/GPT-5.6 Sol hedge; GPT-5.6 Sol vs. Claude Opus 5 (1), then Claude Opus 5 (2) vs Claude Opus 5 (1) and GPT-5.6 Sol versus Claude Opus 5 (2).'
    )
  })

  it('keeps the article "A" that starts a sentence after a label', () => {
    const names = new Map([
      ['Response A', 'Claude Opus 5'],
      ['Response B', 'GPT-5.6 Sol']
    ])
    expect(
      councilNamedText(
        'Response B. A careful reader: Response B: A gap.\nResponse B\nA note',
        names
      )
    ).toBe('GPT-5.6 Sol. A careful reader: GPT-5.6 Sol: A gap.\nGPT-5.6 Sol\nA note')
  })

  it('leaves unknown labels, ranges and words that only start like a label as written', () => {
    const names = new Map([
      ['Response A', 'Claude Opus 5'],
      ['Response B', 'GPT-5.6 Sol']
    ])
    const named = (text: string) => councilNamedText(text, names)
    // Response C never answered, so no reviewer was shown it.
    expect(named('Response C is missing; Responses C and A differ.')).toBe(
      'Response C is missing; Responses C and A differ.'
    )
    expect(named('Response A and I agree.')).toBe('Claude Opus 5 and I agree.')
    expect(named('Responses A-B overlap, Responses A–B too.')).toBe(
      'Responses A-B overlap, Responses A–B too.'
    )
    expect(named('Response Alpha and the responses A and B')).toBe(
      'Response Alpha and the responses A and B'
    )
  })
})
