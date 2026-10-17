// Pure maths behind the Evolve champion drawer: knockout bracket, family Elo and semantic diff.

export const LEADERBOARD_FAMILIES = ['Claude Opus 5.5', 'GPT-6 Astra', 'Gemini 4 Argon'] as const
export type EvolveLeaderboardFamily = (typeof LEADERBOARD_FAMILIES)[number]

export type EvolveBracketRound = 'round_of_4' | 'final' | 'incumbent_challenge'

/** One contender and its blind-audit score in each round it reached; no score = not judged yet. */
export type EvolveBracketEntrant = {
  id: string
  label: string
  family: EvolveLeaderboardFamily
  seed: number
  scores: Partial<Record<EvolveBracketRound, number>>
}
export type EvolveBracketSlot = { entrant: EvolveBracketEntrant; score: number | null }
export type EvolveBracketMatch = {
  id: string
  round: EvolveBracketRound
  top: EvolveBracketSlot | null
  bottom: EvolveBracketSlot | null
  winnerId: string | null
}
export type EvolveBracket = {
  rounds: { round: EvolveBracketRound; matches: EvolveBracketMatch[] }[]
  challenger: EvolveBracketEntrant | null
  champion: EvolveBracketEntrant | null
  incumbentRetained: boolean | null
}
type TieBreak = (top: EvolveBracketSlot, bottom: EvolveBracketSlot) => EvolveBracketSlot
type Pairing = [EvolveBracketEntrant | null, EvolveBracketEntrant | null]

const betterSeed: TieBreak = (top, bottom) =>
  bottom.entrant.seed < top.entrant.seed ? bottom : top
const keepTitle: TieBreak = (top) => top

function slotFor(entrant: EvolveBracketEntrant | null, round: EvolveBracketRound) {
  const score = entrant?.scores[round]
  const judged = typeof score === 'number' && Number.isFinite(score)
  return entrant ? { entrant, score: judged ? score : null } : null
}

function playMatch(id: string, round: EvolveBracketRound, pairing: Pairing, tieBreak: TieBreak) {
  const [top, bottom] = [slotFor(pairing[0], round), slotFor(pairing[1], round)]
  let winnerId: string | null = null
  if (top && bottom && top.score !== null && bottom.score !== null) {
    const tied = top.score === bottom.score
    winnerId = (tied ? tieBreak(top, bottom) : top.score > bottom.score ? top : bottom).entrant.id
  }
  return { id, round, top, bottom, winnerId } satisfies EvolveBracketMatch
}

function winnerOf(match: EvolveBracketMatch): EvolveBracketEntrant | null {
  const slot = [match.top, match.bottom].find((s) => s && s.entrant.id === match.winnerId)
  return slot?.entrant ?? null
}

/** Seeds 1 v 4 and 2 v 3, then the final, then the local incumbent. A tie advances the better seed;
 * the incumbent keeps the title on a tie, because a challenger must beat it outright to promote. */
export function buildKnockoutBracket(
  entrants: readonly EvolveBracketEntrant[],
  incumbent: EvolveBracketEntrant
): EvolveBracket {
  if (entrants.length !== 4) {
    throw new Error('A round-of-4 bracket needs exactly four entrants.')
  }
  if (new Set([incumbent.id, ...entrants.map((entrant) => entrant.id)]).size !== 5) {
    throw new Error('Every bracket entrant and the incumbent need a distinct id.')
  }
  const [s1, s2, s3, s4] = [...entrants].sort((a, b) => a.seed - b.seed)
  const semis = [
    playMatch('r4-1', 'round_of_4', [s1, s4], betterSeed),
    playMatch('r4-2', 'round_of_4', [s2, s3], betterSeed)
  ]
  const final = playMatch('final', 'final', [winnerOf(semis[0]), winnerOf(semis[1])], betterSeed)
  const challenger = winnerOf(final)
  const challenge = playMatch(
    'challenge',
    'incumbent_challenge',
    [incumbent, challenger],
    keepTitle
  )
  const champion = winnerOf(challenge)
  return {
    rounds: [
      { round: 'round_of_4', matches: semis },
      { round: 'final', matches: [final] },
      { round: 'incumbent_challenge', matches: [challenge] }
    ],
    challenger,
    champion,
    incumbentRetained: champion ? champion.id === incumbent.id : null
  }
}

/** A family's pairwise blind-audit record; `warmStartChampion` marks the family seeding this run. */
export type EvolveFamilyRecord = {
  family: EvolveLeaderboardFamily
  wins: number
  losses: number
  draws: number
  warmStartChampion?: boolean
}
type EloBounds = Record<'rating' | 'lower' | 'upper', number | null>
export type EvolveEloStanding = Required<EvolveFamilyRecord> & EloBounds & { games: number }

export const EVOLVE_ELO_BASE = 1500
const Z_95 = 1.959964
// Why: a perfect or empty record maps to an infinite Elo gap; clamping keeps it finite.
const SCORE_FLOOR = 0.01

/** Elo gap implied by an expected score against the field (the logistic Elo curve). */
export function eloFromScore(score: number): number {
  const p = Math.min(1 - SCORE_FLOOR, Math.max(SCORE_FLOOR, score))
  return 400 * Math.log10(p / (1 - p))
}

/** Wilson score interval for a win fraction: it always holds the observed score and stays in 0–1. */
export function wilsonInterval(score: number, games: number, z = Z_95): [number, number] {
  const z2 = z * z
  const denominator = 1 + z2 / games
  const centre = (score + z2 / (2 * games)) / denominator
  const half = (z * Math.sqrt((score * (1 - score) + z2 / (4 * games)) / games)) / denominator
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

const count = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/** Performance Elo per family with 95% bounds, best first. A family without games gets no rating
 * rather than the base rating, so nothing looks measured that was not. */
export function familyEloStandings(records: readonly EvolveFamilyRecord[]): EvolveEloStanding[] {
  const elo = (score: number) => Math.round(EVOLVE_ELO_BASE + eloFromScore(score))
  const standings = LEADERBOARD_FAMILIES.map((family): EvolveEloStanding => {
    const record = records.find((candidate) => candidate.family === family)
    const [wins, losses, draws] = [count(record?.wins), count(record?.losses), count(record?.draws)]
    const games = wins + losses + draws
    const warmStartChampion = record?.warmStartChampion === true
    const row = { family, wins, losses, draws, games, warmStartChampion }
    if (games === 0) {
      return { ...row, rating: null, lower: null, upper: null }
    }
    const score = (wins + draws / 2) / games
    const [low, high] = wilsonInterval(score, games)
    return { ...row, rating: elo(score), lower: elo(low), upper: elo(high) }
  })
  // Rated families first, best first; unrated ones keep the family order (the sort is stable).
  return standings.sort((a, b) =>
    a.rating === null || b.rating === null
      ? Number(a.rating === null) - Number(b.rating === null)
      : b.rating - a.rating
  )
}

export type EvolveDiffKind = 'same' | 'added' | 'removed' | 'modified'
export type EvolveDiffLine = { number: number; text: string }
type Line = EvolveDiffLine | null
export type EvolveDiffRow = { kind: EvolveDiffKind; left: Line; right: Line }
type DiffCounts = Record<Exclude<EvolveDiffKind, 'same'> | 'unchanged', number>
export type EvolveSemanticDiff = DiffCounts & { rows: EvolveDiffRow[] }

// Why: past this many cells the LCS table costs more memory than the drawer is worth.
const MAX_LCS_CELLS = 4_000_000
const MODIFIED_SIMILARITY = 0.4

export function splitLines(text: string): string[] {
  const lines = text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

/** Whitespace and indentation never change behavior, so they never make a line differ. */
const semanticKey = (line: string) => line.trim().replace(/\s+/g, ' ')

/** Dice similarity of the two lines' word sets: 1 = the same words, 0 = nothing shared. */
export function lineSimilarity(a: string, b: string): number {
  const words = (line: string) => new Set(line.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
  const [left, right] = [words(a), words(b)]
  if (left.size + right.size === 0) {
    return 1
  }
  const shared = [...left].filter((word) => right.has(word)).length
  return (2 * shared) / (left.size + right.size)
}

/** LCS edit script as [baseline index, winner index] pairs; -1 marks a removed or added line.
 * Past the cell cap every line counts as changed and the caller pairs them by position. */
function editScript(ka: readonly string[], kb: readonly string[]): [number, number][] {
  const [n, m, width] = [ka.length, kb.length, kb.length + 1]
  const ops: [number, number][] = []
  let [i, j] = [0, 0]
  if ((n + 1) * width <= MAX_LCS_CELLS) {
    const lcs = new Uint32Array((n + 1) * width)
    for (let x = n - 1; x >= 0; x -= 1) {
      for (let y = m - 1; y >= 0; y -= 1) {
        lcs[x * width + y] =
          ka[x] === kb[y]
            ? lcs[(x + 1) * width + y + 1] + 1
            : Math.max(lcs[(x + 1) * width + y], lcs[x * width + y + 1])
      }
    }
    while (i < n && j < m) {
      const same = ka[i] === kb[j]
      if (same || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        ops.push([i, same ? j : -1])
        i += 1
        j += same ? 1 : 0
      } else {
        ops.push([-1, j])
        j += 1
      }
    }
  }
  for (; i < n; i += 1) {
    ops.push([i, -1])
  }
  for (; j < m; j += 1) {
    ops.push([-1, j])
  }
  return ops
}

/** Side-by-side rows, baseline to winner. In each changed block, removed and added lines sharing
 * enough words pair up as one modified row; the rest stay removed or added. */
export function buildSemanticDiff(baseline: string, winner: string): EvolveSemanticDiff {
  const [a, b] = [splitLines(baseline), splitLines(winner)]
  const diff: EvolveSemanticDiff = { rows: [], added: 0, removed: 0, modified: 0, unchanged: 0 }
  const lineOf = (lines: readonly string[], index: number | undefined): Line =>
    index === undefined ? null : { number: index + 1, text: lines[index] }
  const push = (kind: EvolveDiffKind, left: Line, right: Line) => {
    diff.rows.push({ kind, left, right })
    diff[kind === 'same' ? 'unchanged' : kind] += 1
  }
  let removed: number[] = []
  let added: number[] = []
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
      const [left, right] = [lineOf(a, removed[k]), lineOf(b, added[k])]
      if (left && right && lineSimilarity(left.text, right.text) >= MODIFIED_SIMILARITY) {
        push(semanticKey(left.text) === semanticKey(right.text) ? 'same' : 'modified', left, right)
        continue
      }
      if (left) {
        push('removed', left, null)
      }
      if (right) {
        push('added', null, right)
      }
    }
    removed = []
    added = []
  }
  for (const [ai, bi] of editScript(a.map(semanticKey), b.map(semanticKey))) {
    if (ai >= 0 && bi >= 0) {
      flush()
      push('same', lineOf(a, ai), lineOf(b, bi))
    } else if (ai >= 0) {
      removed.push(ai)
    } else {
      added.push(bi)
    }
  }
  flush()
  return diff
}

/** One behavior measured on both sides of the challenge (pass rate, latency, refusals…). */
export type EvolveBehaviorMetric = {
  id: string
  label: string
  baseline: number
  winner: number
  higherIsBetter: boolean
  unit?: string
}
export type EvolveBehaviorDelta = EvolveBehaviorMetric & {
  delta: number
  direction: 'improved' | 'regressed' | 'unchanged'
}

export function behavioralDeltas(metrics: readonly EvolveBehaviorMetric[]): EvolveBehaviorDelta[] {
  return metrics.map((metric) => {
    const delta = metric.winner - metric.baseline
    const better = metric.higherIsBetter ? delta > 0 : delta < 0
    const direction = Math.abs(delta) < 1e-9 ? 'unchanged' : better ? 'improved' : 'regressed'
    return { ...metric, delta, direction }
  })
}

/** "+4.5%", "-120 ms", "±0": the sign is always shown so a delta never reads as a level. */
export function formatSignedDelta(delta: number, unit = '', digits = 1): string {
  const size = Number(Math.abs(delta).toFixed(digits))
  return size === 0 ? `±0${unit}` : `${delta > 0 ? '+' : '-'}${size}${unit}`
}
