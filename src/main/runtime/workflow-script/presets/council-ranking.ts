import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import { localWorkflowModelLabel } from '../../../../shared/local-workflow-model-label'

export type CouncilStanding = {
  label: string
  seatId: string
  averageRank: number
  votes: number
  place: number
}

const MARKER = 'FINAL RANKING:'
const LABEL = /Response [A-Z]/g
/**
 * A ranking heading on its own line with other casing or markdown around it ("**Final
 * Ranking**:", "## FINAL RANKING", "Final ranking (best to worst):"). Without it the whole-text
 * fallback would count the order the reviewer discussed the answers in, which is just the
 * rotated order it was shown them.
 */
const LOOSE_MARKER = /^[ \t#>*_]*final[ \t]+ranking[ \t*_]*(?:\([^)\n]*\)[ \t*_]*)?(?::|$)/gim

/** What joins two letters in one mention: "A and C", "A, B, and D", "A/B", "B vs. A". */
const LIST_JOIN = String.raw`(?:, (?:and |or )?| (?:and|or|&|vs\.?|versus) |/)`
/**
 * "Response B", "Response B's" or a list such as "Responses A and C" / "Response A/B"; the group
 * is the letter list. A range ("Responses A-C") is left alone. A capital "A" right after a join is
 * read as a label: the article is capitalised at a sentence start (after ". ", ": " or a line
 * break), never straight after a join; only Title Case text could be misread.
 */
const MENTION = new RegExp(
  String.raw`\bResponses? ([A-Z](?:${LIST_JOIN}[A-Z])*)\b(?![-–][A-Z]\b)`,
  'g'
)

/** Stable anonymous label for the member at `index` in the frozen member order. */
export function councilMemberLabel(index: number): string {
  return `Response ${String.fromCharCode(65 + index)}`
}

/**
 * A reviewer's evaluation with each anonymous label it wrote replaced by that member's name
 * (`names` maps "Response B" to "GPT-5.6 Sol"), so the chairman reads, and repeats, model names.
 * A mention that starts with a label outside `names` stays as written; a later unknown letter in
 * a list keeps its letter.
 */
export function councilNamedText(text: string, names: ReadonlyMap<string, string>): string {
  return text.replace(MENTION, (mention, letters: string) => {
    const name = (letter: string) => names.get(`Response ${letter}`)
    if (!name(letters[0])) {
      return mention
    }
    return letters.replace(/\b[A-Z]\b/g, (letter) => name(letter) ?? letter)
  })
}

/**
 * Friendly model names; repeated models are numbered so the chairman can tell them apart. The
 * run view names the seats the same way.
 */
export function councilSeatNames(seats: readonly ResolvedLocalWorkflowSeat[]): string[] {
  const names = seats.map((seat) => localWorkflowModelLabel(seat.agent, seat.model))
  return names.map((name, index) =>
    names.filter((other) => other === name).length > 1
      ? `${name} (${names.slice(0, index + 1).filter((other) => other === name).length})`
      : name
  )
}

/** Google lineage answers but never ranks or chairs; an unplaceable family never judges. */
export function councilMayRank(seat: Pick<ResolvedLocalWorkflowSeat, 'lineage'>): boolean {
  return seat.lineage !== 'google' && seat.lineage !== 'unknown'
}

/** Text-mode results arrive as `{ markdown }`; anything else is treated as missing. */
export function councilMarkdown(value: unknown): string | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'markdown' in value &&
    typeof value.markdown === 'string' &&
    value.markdown.trim()
  ) {
    return value.markdown
  }
  return undefined
}

/**
 * Port of karpathy/llm-council `parse_ranking_from_text`: the numbered `Response X` lines after
 * the first `FINAL RANKING:`, else any label after it, else any label in the whole text. Labels
 * are then restricted to the responses the reviewer was shown and deduplicated, first wins. Two
 * deliberate differences: a numbered line may wrap its label in emphasis (`1. **Response B**`),
 * because the original keeps only the plain lines of a list that mixes both styles; and when the
 * exact marker is missing, the section after the last loosely written ranking heading is read
 * before falling back to the whole text.
 */
export function parseCouncilRanking(text: string, labels: readonly string[]): string[] {
  return [...new Set(extractRankingLabels(text).filter((label) => labels.includes(label)))]
}

function rankingSection(text: string): string | undefined {
  if (text.includes(MARKER)) {
    return text.split(MARKER)[1]
  }
  const loose = [...text.matchAll(LOOSE_MARKER)].at(-1)
  return loose ? text.slice(loose.index + loose[0].length) : undefined
}

function extractRankingLabels(text: string): string[] {
  const section = rankingSection(text)
  if (section === undefined) {
    return text.match(LABEL) ?? []
  }
  const numbered = section.match(/\d+\.\s*[*_]*\s*Response [A-Z]/g)
  if (numbered) {
    return numbered.map((match) => match.slice(match.indexOf('Response')))
  }
  return section.match(LABEL) ?? []
}

const roundRank = (value: number): number => Math.round(value * 100) / 100

/** Sorts by average rank (ties keep their input order) and gives equal averages one place. */
export function placeCouncilStandings(
  entries: readonly Omit<CouncilStanding, 'place'>[]
): CouncilStanding[] {
  const sorted = entries
    .filter((entry) => entry.votes > 0)
    .sort((left, right) => left.averageRank - right.averageRank)
  return [
    ...sorted.map((entry) => ({
      ...entry,
      place: 1 + sorted.filter((other) => other.averageRank < entry.averageRank).length
    })),
    // Responses nobody else ranked still appear, after every ranked one.
    ...entries
      .filter((entry) => entry.votes === 0)
      .map((entry) => ({ ...entry, averageRank: 0, votes: 0, place: sorted.length + 1 }))
  ]
}

/**
 * Karpathy's "street cred" (average 1-based position, lower is better) with one estate rule: a
 * member's ballot never counts toward its own response, because the seat that reviews work is
 * never the model that produced it.
 */
export function councilStreetCred(
  responses: readonly { label: string; seatId: string }[],
  ballots: readonly { reviewerSeatId: string; ranking: readonly string[] }[]
): CouncilStanding[] {
  return placeCouncilStandings(
    responses.map((response) => {
      const positions = ballots.flatMap((ballot) => {
        const index =
          ballot.reviewerSeatId === response.seatId ? -1 : ballot.ranking.indexOf(response.label)
        return index < 0 ? [] : [index + 1]
      })
      const total = positions.reduce((sum, position) => sum + position, 0)
      return {
        label: response.label,
        seatId: response.seatId,
        averageRank: positions.length ? roundRank(total / positions.length) : 0,
        votes: positions.length
      }
    })
  )
}

/** Legacy aggregates are 0-based means; the shared view shows 1-based average ranks. */
export function councilRankFromLegacyScore(score: number): number {
  return roundRank(score + 1)
}
