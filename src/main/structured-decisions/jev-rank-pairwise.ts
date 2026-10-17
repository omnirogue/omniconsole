import {
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResult
} from '../../shared/structured-decisions'
import { JEV_TIE_MARGIN } from '../../shared/jev-confidence'
import { JEV_DEFAULT_RUBRIC, jevCriteria } from '../../shared/jev-rubric'
import {
  fitJevText,
  JEV_PAIR_RESPONSE_BYTES,
  jevPool,
  jevReadKey,
  orderJevIds
} from './jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from './typesafe-provider'
import { jevUsageOf } from './jev-certainty'
import type { JevRankRequest, JevRanking } from './jev-rank'

type Ask = (request: DecisionRequest) => Promise<DecisionResult>
/** How one pair in one order got its probability: asked, the same answer, or a tie mirrored. */
type Played = 'asked' | 'same' | 'mirrored'
type Game = readonly [first: number, second: number]

/** Every pair once, in rounds where no answer is in two pairs (the circle method). */
function jevRoundRobin(count: number): [number, number][][] {
  const seats = Array.from({ length: count + (count % 2) }, (_, index) => index)
  const rounds: [number, number][][] = []
  for (let round = 1; round < seats.length; round++) {
    const pairs: [number, number][] = []
    for (let index = 0; index < seats.length / 2; index++) {
      const [a, b] = [seats[index]!, seats[seats.length - 1 - index]!]
      if (a < count && b < count) {
        pairs.push(a < b ? [a, b] : [b, a])
      }
    }
    rounds.push(pairs)
    seats.splice(1, 0, seats.pop()!)
  }
  return rounds
}

/**
 * Every pair in both orders, so the position an answer is shown in cannot decide it, with three
 * kinds of call saved: identical answers tie at 0.5 unasked; a pair JEV ties shown one way is not
 * asked the other way round (JEV rules 11: no order breaks a tie); and a pair whose two answers
 * can no longer reach the top two is not asked, which never changes the top two or the doubt
 * between them. Unsure when the top answer's both-orders probability is in `band`.
 */
export async function rankHeadToHead(
  request: JevRankRequest,
  ask: Ask,
  band: readonly [number, number]
): Promise<JevRanking> {
  const rubric = fitJevText(request.rubric.trim() || JEV_DEFAULT_RUBRIC, 6_000)
  const task = fitJevText(request.task, 6_000)
  const criteria = jevCriteria(request.rubric)
  const count = request.candidates.length
  const texts = request.candidates.map((candidate) =>
    fitJevText(candidate.text, JEV_PAIR_RESPONSE_BYTES)
  )
  const keys = request.candidates.map((candidate) => jevReadKey(candidate.text))
  // p[i][j]: how likely JEV found i better than j when i was shown first.
  const p = Array.from({ length: count }, () => Array.from({ length: count }, () => 0.5))
  const played = Array.from({ length: count }, () =>
    Array.from<Played | undefined>({ length: count })
  )
  const points = Array.from({ length: count }, () => 0)
  // Pairs in one order still to judge, per answer: each can win it at most one point.
  const open = Array.from({ length: count }, () => 0)
  for (let first = 0; first < count; first++) {
    for (let second = 0; second < count; second++) {
      if (first === second) {
        continue
      }
      if (keys[first] === keys[second]) {
        played[first]![second] = 'same'
        points[first]! += 0.5
        points[second]! += 0.5
      } else {
        open[first]!++
        open[second]!++
      }
    }
  }
  const record = (first: number, second: number, wins: [number, number], how: Played) => {
    p[first]![second] = wins[0]
    played[first]![second] = how
    points[first]! += wins[0]
    points[second]! += wins[1]
    open[first]!--
    open[second]!--
  }
  const answers: DecisionResult[] = []
  const drivers = new Map<string, number>()
  /** Asks every game at once; each answer's [first wins, second wins]. */
  const judge = async (games: readonly Game[]): Promise<[number, number][]> => {
    const results = await jevPool(games, ([first, second]) =>
      ask({
        capability: request.capability ?? 'workflow.judge',
        model: TYPESAFE_DEFAULT_MODEL,
        state: {
          task,
          rubric,
          response_1: texts[first]!,
          response_2: texts[second]!
        },
        questions: {
          better: {
            type: 'choice',
            instructions:
              'Which response better does what the task asks, judged by the rubric? Ignore which one is shown first.',
            criteria: { response_1: 'Response 1 is better', response_2: 'Response 2 is better' }
          },
          driver: {
            type: 'choice',
            instructions: 'Which rubric criterion most strongly explains that preference?',
            criteria: Object.fromEntries(
              criteria.map((criterion) => [criterion.id, criterion.question])
            )
          }
        }
      })
    )
    answers.push(...results)
    return results.map((result, index) => {
      const answer = result.answers.better
      if (answer?.type !== 'choice') {
        throw new DecisionProviderError('invalid_response')
      }
      const [first, second] = games[index]!
      const wins: [number, number] = [
        answer.probabilities.response_1 ?? 0,
        answer.probabilities.response_2 ?? 0
      ]
      record(first, second, wins, 'asked')
      // Which criterion decided is a hint for the next round: a missing one never voids the verdict.
      const driver = result.answers.driver
      if (
        driver?.type === 'choice' &&
        criteria.some((criterion) => criterion.id === driver.choice)
      ) {
        drivers.set(driver.choice, (drivers.get(driver.choice) ?? 0) + 1)
      }
      return wins
    })
  }
  for (const round of jevRoundRobin(count)) {
    // Second-best points only grow: an answer that cannot reach them now never reaches the top two.
    const runnerUp = [...points].sort((left, right) => right - left)[1] ?? 0
    const out = (index: number) => points[index]! + open[index]! < runnerUp
    const forward = round.filter(([a, b]) => {
      if (keys[a] === keys[b]) {
        return false
      }
      if (out(a) && out(b)) {
        open[a]! -= 2
        open[b]! -= 2
        return false
      }
      return true
    })
    const leans = await judge(forward)
    const reverse = forward.flatMap(([a, b], index): Game[] => {
      const wins = leans[index]!
      if (Math.abs(wins[0] - wins[1]) < JEV_TIE_MARGIN) {
        record(b, a, [wins[1], wins[0]], 'mirrored')
        return []
      }
      return [[b, a]]
    })
    await judge(reverse)
  }
  const ids = request.candidates.map((candidate) => candidate.id)
  const order = orderJevIds(ids, points)
  const games = 2 * (count - 1)
  // How sure JEV is that the top answer beats another, from both orders; the reason if it is not.
  const doubt = (top: number, other: number, which: string): string | undefined => {
    const shownFirst = p[top]![other]!
    const shownSecond = 1 - p[other]![top]!
    const both = (shownFirst + shownSecond) / 2
    if (shownFirst >= 0.5 !== shownSecond >= 0.5) {
      return `it preferred a different answer depending on which was shown first (the top answer against ${which})`
    }
    return both > band[0] && both < band[1]
      ? `it preferred the top answer over ${which} with probability ${both.toFixed(2)}, inside ${band[0]}–${band[1]}`
      : undefined
  }
  const top = ids.indexOf(order[0])
  const incumbent = request.incumbent === undefined ? -1 : ids.indexOf(request.incumbent)
  const unsureReason =
    count > 1
      ? (doubt(top, ids.indexOf(order[1]), 'the next') ??
        (incumbent >= 0 && incumbent !== top
          ? doubt(top, incumbent, 'the best version so far')
          : undefined))
      : undefined
  const unsure = unsureReason !== undefined
  const usage = jevUsageOf(answers)
  return {
    method: 'pairwise',
    model: TYPESAFE_DEFAULT_MODEL,
    order,
    scores: Object.fromEntries(ids.map((id, index) => [id, points[index]! / games])),
    criteria: [],
    drivers: criteria
      .map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        comparisons: drivers.get(criterion.id) ?? 0
      }))
      .filter((driver) => driver.comparisons > 0)
      .sort((left, right) => right.comparisons - left.comparisons),
    // What JEV was shown or the same answer twice; a mirrored tie or a pair never asked is not.
    pairs: ids.flatMap((first, row) =>
      ids.flatMap((second, column) =>
        played[row]![column] === 'asked' || played[row]![column] === 'same'
          ? [{ first, second, probability: p[row]![column]! }]
          : []
      )
    ),
    ...(usage ? { usage } : {}),
    unsure,
    ...(unsureReason ? { unsureReason } : {}),
    calls: answers.length
  }
}
