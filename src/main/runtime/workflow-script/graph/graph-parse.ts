export type GraphVerdict = 'pass' | 'fail' | 'unsure'

/** Whole verdict phrases, normalized to lower case with single underscores. */
const VERDICT_WORDS: Record<string, GraphVerdict> = {
  pass: 'pass',
  passes: 'pass',
  passed: 'pass',
  approve: 'pass',
  approved: 'pass',
  accept: 'pass',
  accepted: 'pass',
  real: 'pass',
  confirm: 'pass',
  confirmed: 'pass',
  valid: 'pass',
  fail: 'fail',
  fails: 'fail',
  failed: 'fail',
  reject: 'fail',
  rejected: 'fail',
  refute: 'fail',
  refuted: 'fail',
  invalid: 'fail',
  changes: 'fail',
  changes_requested: 'fail',
  request_changes: 'fail',
  requested_changes: 'fail',
  not_approved: 'fail',
  unsure: 'unsure',
  unjudged: 'unsure',
  uncertain: 'unsure',
  unknown: 'unsure',
  inconclusive: 'unsure',
  undetermined: 'unsure'
}

/**
 * The review's verdict: the last line that is a `VERDICT:` line, tolerant of markdown around it
 * (`**VERDICT: PASS**`, `> Verdict — approve.`). Only that line counts, and only a whole known
 * phrase: a verdict quoted mid-sentence is not one, and a last line that says something unknown
 * is undefined rather than falling back to an earlier verdict, so the call is asked again.
 */
export function parseGraphVerdict(text: string): GraphVerdict | undefined {
  const lines = [...text.matchAll(/^[ \t>*_#`-]*verdict[ \t*_`]*[:\-–—][ \t*_`]*(.*)$/gim)]
  const last = lines.at(-1)
  if (!last) {
    return undefined
  }
  // "PASS — the fix is correct": what follows a separator explains the verdict.
  const value = last[1].split(/\s*(?:[—–;:,(]|\s-\s)\s*/)[0]
  const phrase = value
    .toLowerCase()
    .replace(/[*_`.!]+/g, ' ')
    .trim()
    .replace(/[\s-]+/g, '_')
  return VERDICT_WORDS[phrase]
}

export const GRAPH_VERDICT_PROBLEM =
  'End your answer with one line: VERDICT: PASS, VERDICT: FAIL or VERDICT: UNSURE.'

export function graphLabel(index: number): string {
  return `Response ${String.fromCharCode(65 + index)}`
}

/**
 * A ballot: the numbered list under the last "FINAL RANKING" heading (exact, or written with
 * other casing or markdown), naming every shown response exactly once. Unlike the legacy Council
 * parser there is no fallback to the order responses were discussed in: without the list there
 * is no ballot, and the call is asked again.
 */
export function parseGraphBallot(text: string, labels: readonly string[]): string[] | undefined {
  const headings = [...text.matchAll(/^[ \t#>*_]*final[ \t]+ranking\b[^\n]*$/gim)]
  const last = headings.at(-1)
  if (!last) {
    return undefined
  }
  const section = text.slice(last.index + last[0].length)
  // Ordered by the numbers written, which must be 1..n, each once.
  const entries = [
    ...section.matchAll(/^[ \t]*(\d+)[.)][ \t]*[*_`]*[ \t]*(Response [A-Z])\b/gm)
  ].map((match) => ({ place: Number(match[1]), label: match[2] }))
  const places = entries.map((entry) => entry.place).sort((a, b) => a - b)
  const ranking = [...entries].sort((a, b) => a.place - b.place).map((entry) => entry.label)
  return ranking.length === labels.length &&
    places.every((place, index) => place === index + 1) &&
    new Set(ranking).size === labels.length &&
    ranking.every((label) => labels.includes(label))
    ? ranking
    : undefined
}

export function graphBallotProblem(labels: readonly string[]): string {
  return `End with "FINAL RANKING:" and a numbered list of all ${labels.length} responses, best first, each exactly once: ${labels.join(', ')}.`
}

export type GraphStanding = {
  label: string
  /** Candidate position in the frozen order (step input order, then agent order). */
  candidate: number
  averageRank: number
  votes: number
  place: number
}

/**
 * The answers a judge may place: every answer but its own model's, or all of them when every
 * answer is its own model's (one model improving its own work favours no answer).
 */
function graphEligible(
  candidates: readonly { label: string; seatId: string }[],
  seatId: string
): Set<string> {
  const allOwn = candidates.every((other) => other.seatId === seatId)
  return new Set(
    candidates.filter((other) => allOwn || other.seatId !== seatId).map((other) => other.label)
  )
}

/**
 * Whether every pair of answers has a judge allowed to place both. With two families judging
 * each other's work, no model judge may compare a Claude answer with a GPT one.
 */
export function graphJudgesCompareEveryPair(
  candidates: readonly { label: string; seatId: string }[],
  seatIds: readonly string[]
): boolean {
  const pools = seatIds.map((seatId) => graphEligible(candidates, seatId))
  return candidates.every((first, index) =>
    candidates
      .slice(index + 1)
      .every((second) => pools.some((pool) => pool.has(first.label) && pool.has(second.label)))
  )
}

/**
 * Average normalized rank per candidate, shown on the full candidate scale. A voter's own family
 * is removed before positions are read. Normalizing each remaining pool makes different pool
 * sizes comparable; a ballot with only one eligible answer contributes a neutral midpoint.
 */
export function graphStandings(
  candidates: readonly { label: string; seatId: string }[],
  ballots: readonly { seatId: string; ranking: readonly string[] }[]
): GraphStanding[] {
  const entries = candidates.map((candidate, index) => {
    const positions = ballots.flatMap((ballot) => {
      const allowed = graphEligible(candidates, ballot.seatId)
      if (!allowed.has(candidate.label)) {
        return []
      }
      const eligible = ballot.ranking.filter((label) => allowed.has(label))
      const position = eligible.indexOf(candidate.label)
      if (position === -1) {
        return []
      }
      const percentile = eligible.length === 1 ? 0.5 : position / (eligible.length - 1)
      return [1 + percentile * (candidates.length - 1)]
    })
    const total = positions.reduce((sum, position) => sum + position, 0)
    return {
      label: candidate.label,
      candidate: index,
      averageRank: positions.length ? Math.round((total / positions.length) * 100) / 100 : 0,
      votes: positions.length
    }
  })
  const ranked = entries
    .filter((entry) => entry.votes > 0)
    .sort((left, right) => left.averageRank - right.averageRank || left.candidate - right.candidate)
  return [
    ...ranked.map((entry) => ({
      ...entry,
      place: 1 + ranked.filter((other) => other.averageRank < entry.averageRank).length
    })),
    ...entries
      .filter((entry) => entry.votes === 0)
      .map((entry) => ({ ...entry, place: ranked.length + 1 }))
  ]
}

export type GraphTally = 'confirmed' | 'refuted' | 'unverified'

/**
 * Majority of the configured votes. A missing vote (the agent failed) counts toward neither side,
 * so it can keep a finding unverified but can never refute it.
 */
export function graphTally(votes: readonly (GraphVerdict | null)[]): GraphTally {
  const pass = votes.filter((vote) => vote === 'pass').length
  const fail = votes.filter((vote) => vote === 'fail').length
  if (pass * 2 > votes.length) {
    return 'confirmed'
  }
  if (fail * 2 > votes.length) {
    return 'refuted'
  }
  return 'unverified'
}
