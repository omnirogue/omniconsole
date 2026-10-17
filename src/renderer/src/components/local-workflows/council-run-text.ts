import type {
  LocalWorkflowCallView,
  LocalWorkflowCouncilRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'

export type CouncilMember = LocalWorkflowCouncilRun['members'][number]

/** Mirrors main's COUNCIL_REVISION: the Karpathy council, where reviewers rank every answer. */
const KARPATHY_COUNCIL_REVISION = 6

/**
 * Revision 6 reviewers rank every answer, their own included (that vote is dropped). Revisions
 * 1-5, legacy and working agents, showed each reviewer only the answers it did not write.
 */
export function councilReviewersRankedEveryAnswer(view: Pick<LocalWorkflowView, 'revision'>) {
  return view.revision === KARPATHY_COUNCIL_REVISION
}

/** What joins the letters of a list: "A, B", "A/B", "A & B", "A and B", "A, B, or C". */
const LIST_JOIN = String.raw`(?:\s*[,/&]\s*|\s*,?\s+(?:and|or)\s+)`
/** A range ("B–D", "A to C") names letters it never writes, so it is never mapped. */
const RANGE_JOIN = String.raw`\s*(?:[-–—]|to\b|through\b)\s*`
/**
 * "Responses A and C", "Responses A, B, and D": the whole list after the plural, and nothing when
 * a range or another letter follows (the list then is not all there).
 */
const PLURAL = new RegExp(
  String.raw`\bResponses ([A-Z](?:${LIST_JOIN}[A-Z])*)\b(?!(?:${LIST_JOIN}|${RANGE_JOIN})[A-Z]\b)`,
  'g'
)
/** "Response A", "Response A/B/C/D"; not "Response A–C" or "Response A, B" (half a list). */
const SINGULAR = /\bResponse ([A-Z](?:\/[A-Z])*)\b(?!\s*[-–—/,&]\s*[A-Z]\b)/g
/** A bold span on one line: its references read as plain names inside the writer's own bold. */
const BOLD_SPAN = /(\*\*[^*\n]+?\*\*)/

/**
 * Karpathy's council writes anonymous labels ("Response B"); readers see model names in bold
 * instead, in the rankings and in the chairman's answer alike. A list after "Responses" (or
 * "Response A/B") maps every letter, or none when one of them is unknown or it is a range.
 * Unknown labels, and bare letters with no "Response" before them ("B's point"), stay as
 * written: a lone capital may just be a word.
 */
export function deanonymizeCouncilText(text: string, members: readonly CouncilMember[]): string {
  const byLetter = new Map<string, string>()
  for (const member of members) {
    const letter = /^Response ([A-Z])$/.exec(member.label)?.[1]
    if (letter) {
      byLetter.set(letter, member.modelLabel)
    }
  }
  const named = (list: string, bold: boolean) => {
    const letters = list.match(/\b[A-Z]\b/g) ?? []
    if (!letters.length || !letters.every((letter) => byLetter.has(letter))) {
      return undefined
    }
    return list.replace(/\b[A-Z]\b/g, (letter) => {
      const model = byLetter.get(letter) ?? letter
      return bold ? `**${model}**` : model
    })
  }
  const nameAll = (part: string, bold: boolean) =>
    part
      .replace(PLURAL, (match, list: string) => named(list, bold) ?? match)
      .replace(SINGULAR, (match, list: string) => named(list, bold) ?? match)
  // Odd parts are the writer's bold spans: bolding names inside them again would break them.
  return text
    .split(BOLD_SPAN)
    .map((part, index) => nameAll(part, index % 2 === 0))
    .join('')
}

export function councilMemberByLabel(
  run: LocalWorkflowCouncilRun,
  label: string
): CouncilMember | undefined {
  return run.members.find((member) => member.label === label)
}

export function workflowCall(
  view: LocalWorkflowView,
  callId: string | undefined
): LocalWorkflowCallView | undefined {
  return callId ? view.calls.find((call) => call.id === callId) : undefined
}

/** A voter's ranking call: from its ballot once accepted, else by seat within the stage. */
export function councilRankCall(
  view: LocalWorkflowView,
  run: LocalWorkflowCouncilRun,
  stageCalls: readonly LocalWorkflowCallView[],
  seatId: string
): LocalWorkflowCallView | undefined {
  const ballot = run.ballots.find((entry) => entry.reviewerSeatId === seatId)
  return (
    workflowCall(view, ballot?.callId) ??
    stageCalls.find((call) => call.seatId === seatId || call.id.endsWith(`/${seatId}`))
  )
}

/**
 * "1", "2", "2", "4": standings already carry shared places for ties. An answer no counted vote
 * ranked has no average (the host writes 0), so it goes last instead of looking like first.
 */
export function councilStandingRows(run: LocalWorkflowCouncilRun) {
  return run.standings
    .toSorted(
      (left, right) =>
        Number(!left.votes) - Number(!right.votes) ||
        left.place - right.place ||
        left.averageRank - right.averageRank
    )
    .map((standing) => ({ ...standing, member: councilMemberByLabel(run, standing.label) }))
}
