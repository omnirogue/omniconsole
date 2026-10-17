// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolveLeaderboardDrawer, type EvolveLeaderboard } from './EvolveLeaderboardDrawer'
import {
  behavioralDeltas,
  buildKnockoutBracket,
  buildSemanticDiff,
  eloFromScore,
  familyEloStandings,
  formatSignedDelta,
  lineSimilarity,
  splitLines,
  wilsonInterval,
  type EvolveBracketEntrant,
  type EvolveLeaderboardFamily
} from './evolve-leaderboard-helpers'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, values?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

function entrant(
  id: string,
  family: EvolveLeaderboardFamily,
  seed: number,
  scores: EvolveBracketEntrant['scores']
): EvolveBracketEntrant {
  return { id, label: `${id} candidate`, family, seed, scores }
}

const BASELINE = [
  'You are a support agent.',
  'Answer in English.',
  'Keep answers short.',
  'Never promise refunds.',
  ''
].join('\n')
const WINNER = [
  'You are a support agent.',
  'Answer in the customer language.',
  'Keep answers short.',
  'Cite the order number.',
  ''
].join('\n')

function entrants(): EvolveBracketEntrant[] {
  // Listed out of seed order on purpose: the bracket seeds by `seed`, not by position.
  return [
    entrant('argon', 'Gemini 4 Argon', 3, { round_of_4: 0.79 }),
    entrant('opus', 'Claude Opus 5.5', 1, {
      round_of_4: 0.91,
      final: 0.88,
      incumbent_challenge: 0.86
    }),
    entrant('opus-b', 'Claude Opus 5.5', 4, { round_of_4: 0.77 }),
    entrant('astra', 'GPT-6 Astra', 2, { round_of_4: 0.84, final: 0.81 })
  ]
}

const incumbent = () => entrant('local', 'Claude Opus 5.5', 0, { incumbent_challenge: 0.8 })

function leaderboardFixture(overrides: Partial<EvolveLeaderboard> = {}): EvolveLeaderboard {
  return {
    runId: 'run_si_42',
    entrants: entrants(),
    incumbent: incumbent(),
    familyRecords: [
      { family: 'GPT-6 Astra', wins: 6, losses: 6, draws: 0 },
      { family: 'Claude Opus 5.5', wins: 9, losses: 3, draws: 0, warmStartChampion: true },
      { family: 'Gemini 4 Argon', wins: 3, losses: 9, draws: 0 }
    ],
    baseline: { label: 'cand_local', text: BASELINE },
    winner: { label: 'cand_si_9', text: WINNER },
    behaviors: [
      {
        id: 'pass',
        label: 'Pass rate',
        baseline: 82,
        winner: 91.5,
        higherIsBetter: true,
        unit: '%'
      },
      {
        id: 'latency',
        label: 'Latency',
        baseline: 1200,
        winner: 1450,
        higherIsBetter: false,
        unit: ' ms'
      },
      { id: 'refusals', label: 'Refusals', baseline: 3, winner: 3, higherIsBetter: false }
    ],
    ...overrides
  }
}

function renderDrawer(overrides: Partial<EvolveLeaderboard> = {}, onOpenChange = vi.fn()) {
  render(
    <EvolveLeaderboardDrawer
      open
      onOpenChange={onOpenChange}
      leaderboard={leaderboardFixture(overrides)}
    />
  )
  return onOpenChange
}

const match = (id: string) => screen.getByTestId(`evolve-bracket-match-${id}`)
const advancing = (element: HTMLElement) =>
  element.querySelector<HTMLElement>('[data-advances="true"]')
const diffKinds = () =>
  Array.from(document.querySelectorAll('tbody tr[data-kind]')).map((row) =>
    row.getAttribute('data-kind')
  )
const eloRow = (family: EvolveLeaderboardFamily) =>
  document.querySelector<HTMLElement>(`tr[data-family="${family}"]`) as HTMLElement

afterEach(() => {
  cleanup()
})

describe('buildKnockoutBracket', () => {
  it('seeds 1 v 4 and 2 v 3, advances the winners and crowns a challenger that beats the incumbent', () => {
    const bracket = buildKnockoutBracket(entrants(), incumbent())
    const [semis, finals, challenge] = bracket.rounds
    expect(bracket.rounds.map((round) => round.round)).toEqual([
      'round_of_4',
      'final',
      'incumbent_challenge'
    ])
    expect(semis.matches.map((m) => [m.top?.entrant.id, m.bottom?.entrant.id, m.winnerId])).toEqual(
      [
        ['opus', 'opus-b', 'opus'],
        ['astra', 'argon', 'astra']
      ]
    )
    expect(finals.matches[0]).toMatchObject({
      winnerId: 'opus',
      top: { score: 0.88 },
      bottom: { score: 0.81 }
    })
    expect(challenge.matches[0].top?.entrant.id).toBe('local')
    expect(challenge.matches[0].bottom?.entrant.id).toBe('opus')
    expect(bracket.challenger?.id).toBe('opus')
    expect(bracket.champion?.id).toBe('opus')
    expect(bracket.incumbentRetained).toBe(false)
  })

  it('breaks ties for the better seed and lets the incumbent keep the title on a tie', () => {
    const level = { round_of_4: 0.5, final: 0.5, incumbent_challenge: 0.5 }
    const tied = entrants().map((candidate) => ({ ...candidate, scores: level }))
    const bracket = buildKnockoutBracket(tied, { ...incumbent(), scores: level })
    expect(bracket.rounds.map((round) => round.matches.map((m) => m.winnerId))).toEqual([
      ['opus', 'astra'],
      ['opus'],
      ['local']
    ])
    expect(bracket.champion?.id).toBe('local')
    expect(bracket.incumbentRetained).toBe(true)
  })

  it('leaves later rounds open while a score is missing or not a finite number', () => {
    const pending = entrants().map((candidate) =>
      candidate.id === 'astra'
        ? { ...candidate, scores: { round_of_4: 0.84, final: Number.NaN } }
        : candidate
    )
    const bracket = buildKnockoutBracket(pending, incumbent())
    const final = bracket.rounds[1].matches[0]
    const challenge = bracket.rounds[2].matches[0]
    expect(final.winnerId).toBeNull()
    expect(final.bottom).toEqual({ entrant: expect.objectContaining({ id: 'astra' }), score: null })
    expect(challenge.top?.entrant.id).toBe('local')
    expect(challenge.bottom).toBeNull()
    expect(challenge.winnerId).toBeNull()
    expect(bracket).toMatchObject({ challenger: null, champion: null, incumbentRetained: null })
  })

  it('refuses a bracket without exactly four distinct entrants', () => {
    expect(() => buildKnockoutBracket(entrants().slice(0, 3), incumbent())).toThrow(
      'A round-of-4 bracket needs exactly four entrants.'
    )
    expect(() => buildKnockoutBracket(entrants(), { ...incumbent(), id: 'opus' })).toThrow(
      'Every bracket entrant and the incumbent need a distinct id.'
    )
  })
})

describe('familyEloStandings', () => {
  it('rates every family best first with 95% bounds that hold the rating', () => {
    const standings = familyEloStandings(leaderboardFixture().familyRecords)
    expect(standings.map((s) => [s.family, s.rating, s.games])).toEqual([
      ['Claude Opus 5.5', 1691, 12],
      ['GPT-6 Astra', 1500, 12],
      ['Gemini 4 Argon', 1309, 12]
    ])
    for (const standing of standings) {
      expect(standing.lower).toBeLessThan(standing.rating as number)
      expect(standing.upper).toBeGreaterThan(standing.rating as number)
    }
    // An even record is symmetric around the base rating.
    expect(standings[1]).toMatchObject({ lower: 1313, upper: 1687 })
    expect(standings.filter((s) => s.warmStartChampion).map((s) => s.family)).toEqual([
      'Claude Opus 5.5'
    ])
  })

  it('counts draws as half a win and leaves a family without games unrated and last', () => {
    const standings = familyEloStandings([
      { family: 'GPT-6 Astra', wins: 0, losses: 4, draws: 0 },
      { family: 'Gemini 4 Argon', wins: 2, losses: 1, draws: 1 },
      { family: 'Claude Opus 5.5', wins: -3, losses: Number.NaN, draws: 0 }
    ])
    expect(standings.map((s) => s.family)).toEqual([
      'Gemini 4 Argon',
      'GPT-6 Astra',
      'Claude Opus 5.5'
    ])
    expect(standings[0]).toMatchObject({ rating: 1589, games: 4 })
    expect(standings[1].rating).toBe(702)
    expect(standings[2]).toMatchObject({
      wins: 0,
      losses: 0,
      games: 0,
      rating: null,
      lower: null,
      upper: null
    })
  })

  it('keeps Elo finite at perfect records and the Wilson interval inside 0–1', () => {
    expect(eloFromScore(0.5)).toBe(0)
    expect(Number.isFinite(eloFromScore(1))).toBe(true)
    expect(eloFromScore(1)).toBeCloseTo(-eloFromScore(0))
    const [low, high] = wilsonInterval(0, 10)
    expect(low).toBe(0)
    expect(high).toBeGreaterThan(0)
    expect(high).toBeLessThan(1)
  })
})

describe('buildSemanticDiff', () => {
  it('pairs similar changed lines as modified and keeps unrelated ones as removed and added', () => {
    const diff = buildSemanticDiff(BASELINE, WINNER)
    expect(diff.rows.map((row) => row.kind)).toEqual([
      'same',
      'modified',
      'same',
      'removed',
      'added'
    ])
    expect(diff).toMatchObject({ added: 1, removed: 1, modified: 1, unchanged: 2 })
    expect(diff.rows[1]).toEqual({
      kind: 'modified',
      left: { number: 2, text: 'Answer in English.' },
      right: { number: 2, text: 'Answer in the customer language.' }
    })
    expect(diff.rows[3].right).toBeNull()
    expect(diff.rows[4].left).toBeNull()
  })

  it('aligns insertions and removals with their own line numbers', () => {
    const diff = buildSemanticDiff('one\ntwo\nthree', 'zero\none\nthree\nfour')
    expect(
      diff.rows.map((row) => [row.kind, row.left?.number ?? null, row.right?.number ?? null])
    ).toEqual([
      ['added', null, 1],
      ['same', 1, 2],
      ['removed', 2, null],
      ['same', 3, 3],
      ['added', null, 4]
    ])
  })

  it('ignores whitespace and line-ending changes, which never change behavior', () => {
    const diff = buildSemanticDiff('a  b\r\n  c\r\n', 'a b\nc')
    expect(diff.rows.map((row) => row.kind)).toEqual(['same', 'same'])
    expect(diff.rows[1]).toMatchObject({ left: { text: '  c' }, right: { text: 'c' } })
    expect(splitLines('')).toEqual([])
    expect(splitLines('x\n')).toEqual(['x'])
  })

  it('treats an empty side as all added and still diffs inputs too large for the LCS table', () => {
    expect(buildSemanticDiff('', 'x\ny')).toMatchObject({ added: 2, removed: 0, unchanged: 0 })
    const lines = Array.from({ length: 2500 }, (_, index) => `line ${index}`)
    const changed = [...lines]
    changed[1000] = 'something entirely different'
    const diff = buildSemanticDiff(lines.join('\n'), changed.join('\n'))
    expect(diff).toMatchObject({ added: 1, removed: 1, modified: 0, unchanged: 2499 })
  })

  it('scores line similarity on shared words', () => {
    expect(lineSimilarity('Answer in English.', 'Answer in the customer language.')).toBe(0.5)
    expect(lineSimilarity('Never promise refunds.', 'Cite the order number.')).toBe(0)
    expect(lineSimilarity('', '   ')).toBe(1)
  })
})

describe('behavioralDeltas', () => {
  it('judges each delta by whether higher is better', () => {
    const deltas = behavioralDeltas(leaderboardFixture().behaviors)
    expect(deltas.map((d) => [d.id, d.delta, d.direction])).toEqual([
      ['pass', 9.5, 'improved'],
      ['latency', 250, 'regressed'],
      ['refusals', 0, 'unchanged']
    ])
    expect(formatSignedDelta(9.5, '%')).toBe('+9.5%')
    expect(formatSignedDelta(-250, ' ms')).toBe('-250 ms')
    expect(formatSignedDelta(-0.04)).toBe('±0')
  })
})

describe('EvolveLeaderboardDrawer', () => {
  it('renders nothing while closed', () => {
    render(
      <EvolveLeaderboardDrawer
        open={false}
        onOpenChange={vi.fn()}
        leaderboard={leaderboardFixture()}
      />
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('draws the bracket with scores, advancing winners and the new champion', () => {
    renderDrawer()
    expect(screen.getByRole('dialog', { name: 'Champion leaderboard' })).toBeInTheDocument()
    expect(screen.getByText(/^Run run_si_42:/)).toBeInTheDocument()
    for (const [round, label] of [
      ['round_of_4', 'Round of 4'],
      ['final', 'Final'],
      ['incumbent_challenge', 'Incumbent challenge']
    ]) {
      expect(
        within(screen.getByTestId(`evolve-bracket-round-${round}`)).getByText(label)
      ).toBeVisible()
    }
    const semi = match('r4-1')
    expect(within(semi).getByText('0.9100')).toBeInTheDocument()
    expect(within(semi).getByText('0.7700')).toBeInTheDocument()
    expect(within(advancing(semi) as HTMLElement).getByText('opus candidate')).toBeInTheDocument()
    expect(
      within(advancing(semi) as HTMLElement).getByRole('img', { name: 'Advances' })
    ).toBeInTheDocument()
    expect(semi.querySelectorAll('[data-advances="true"]')).toHaveLength(1)
    expect(
      within(advancing(match('r4-2')) as HTMLElement).getByText('astra candidate')
    ).toBeVisible()
    expect(
      within(advancing(match('final')) as HTMLElement).getByText('opus candidate')
    ).toBeVisible()
    const challenge = match('challenge')
    expect(within(challenge).getByText('Incumbent')).toBeInTheDocument()
    expect(within(advancing(challenge) as HTMLElement).getByText('opus candidate')).toBeVisible()
    expect(
      screen.getByText('opus candidate (Claude Opus 5.5) beat the local baseline.')
    ).toBeVisible()
  })

  it('says when the incumbent keeps the title', () => {
    const tie = entrants().map((candidate) =>
      candidate.id === 'opus'
        ? { ...candidate, scores: { ...candidate.scores, incumbent_challenge: 0.8 } }
        : candidate
    )
    renderDrawer({ entrants: tie })
    expect(
      within(advancing(match('challenge')) as HTMLElement).getByText('local candidate')
    ).toBeVisible()
    expect(screen.getByText('local candidate keeps the title.')).toBeVisible()
  })

  it('shows open matches while the bracket is still being judged', () => {
    const pending = entrants().map((candidate) =>
      candidate.id === 'astra' ? { ...candidate, scores: { round_of_4: 0.84 } } : candidate
    )
    renderDrawer({ entrants: pending })
    expect(within(match('final')).getByText('Awaiting result')).toBeVisible()
    expect(advancing(match('final'))).toBeNull()
    expect(within(match('challenge')).getByText('To be decided')).toBeVisible()
    expect(screen.getByText('The bracket is still being judged.')).toBeVisible()
  })

  it('explains a bracket it cannot draw and still shows the rest of the drawer', () => {
    renderDrawer({ entrants: entrants().slice(0, 3) })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This bracket cannot be drawn: A round-of-4 bracket needs exactly four entrants.'
    )
    expect(screen.queryByTestId('evolve-bracket-match-final')).toBeNull()
    expect(eloRow('Claude Opus 5.5')).toBeInTheDocument()
  })

  it('lists Elo and 95% bounds per family, best first, with the warm-start champion badge', () => {
    renderDrawer()
    const families = Array.from(document.querySelectorAll('tr[data-family]')).map((row) =>
      row.getAttribute('data-family')
    )
    expect(families).toEqual(['Claude Opus 5.5', 'GPT-6 Astra', 'Gemini 4 Argon'])
    const opus = eloRow('Claude Opus 5.5')
    expect(within(opus).getByText('1691')).toBeInTheDocument()
    expect(within(opus).getByText('1478–1904')).toBeInTheDocument()
    expect(within(opus).getByText('9–3–0')).toBeInTheDocument()
    expect(within(opus).getByText('Warm-start champion')).toBeVisible()
    expect(within(eloRow('GPT-6 Astra')).getByText('1313–1687')).toBeInTheDocument()
    expect(within(eloRow('GPT-6 Astra')).queryByText('Warm-start champion')).toBeNull()
    expect(within(eloRow('Gemini 4 Argon')).getByText('1309')).toBeInTheDocument()
  })

  it('shows an unrated family without inventing a rating', () => {
    renderDrawer({ familyRecords: [{ family: 'GPT-6 Astra', wins: 2, losses: 2, draws: 0 }] })
    const opus = eloRow('Claude Opus 5.5')
    expect(within(opus).getAllByText('—')).toHaveLength(2)
    expect(within(opus).getByText('0–0–0')).toBeInTheDocument()
  })

  it('diffs the local baseline against the hosted winner side by side', () => {
    renderDrawer()
    const table = screen.getByRole('table', { name: 'Side-by-side semantic diff' })
    expect(within(table).getByText('Local baseline (incumbent): cand_local')).toBeVisible()
    expect(within(table).getByText('Hosted Super Intelligence winner: cand_si_9')).toBeVisible()
    expect(diffKinds()).toEqual(['same', 'modified', 'same', 'removed', 'added'])
    const modified = table.querySelector<HTMLElement>('tr[data-kind="modified"]') as HTMLElement
    expect(within(modified).getByText('Answer in English.')).toBeInTheDocument()
    expect(within(modified).getByText('Answer in the customer language.')).toBeInTheDocument()
    expect(within(modified).getByText('Modified')).toHaveClass('sr-only')
    const removed = table.querySelector<HTMLElement>('tr[data-kind="removed"]') as HTMLElement
    expect(within(removed).getByText('Never promise refunds.')).toBeInTheDocument()
    expect(within(removed).getByText('Never promise refunds.')).toHaveClass('bg-red-500/15')
    const added = table.querySelector<HTMLElement>('tr[data-kind="added"]') as HTMLElement
    expect(within(added).getByText('Cite the order number.')).toHaveClass('bg-emerald-500/15')
    const summary = within(screen.getByRole('list', { name: 'Diff summary' }))
    for (const text of ['Added: 1', 'Removed: 1', 'Modified: 1', 'Unchanged: 2']) {
      expect(summary.getByText(text)).toBeVisible()
    }
  })

  it('lists key behavioral deltas with their direction', () => {
    renderDrawer()
    const items = within(screen.getByRole('list', { name: 'Key behavioral deltas' })).getAllByRole(
      'listitem'
    )
    expect(items.map((item) => item.getAttribute('data-direction'))).toEqual([
      'improved',
      'regressed',
      'unchanged'
    ])
    expect(within(items[0]).getByText('82% → 91.5%')).toBeVisible()
    expect(within(items[0]).getByText('+9.5%')).toBeVisible()
    expect(within(items[0]).getByText('Improved')).toBeVisible()
    expect(within(items[1]).getByText('1200 ms → 1450 ms')).toBeVisible()
    expect(within(items[1]).getByText('+250 ms')).toBeVisible()
    expect(within(items[1]).getByText('Regressed')).toBeVisible()
    expect(within(items[2]).getByText('±0')).toBeVisible()
  })

  it('says so when the winner changes nothing, and omits empty delta lists', () => {
    renderDrawer({
      winner: { label: 'cand_same', text: BASELINE.replace('short.', 'short. ') },
      behaviors: []
    })
    expect(
      screen.getByText('No semantic differences: the winner matches the baseline line for line.')
    ).toBeVisible()
    expect(screen.queryByRole('table', { name: 'Side-by-side semantic diff' })).toBeNull()
    expect(screen.queryByRole('list', { name: 'Key behavioral deltas' })).toBeNull()
  })

  it('closes through the sheet close button', () => {
    const onOpenChange = renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
