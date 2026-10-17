import { COUNCIL_MAX_MEMBERS, COUNCIL_MIN_MEMBERS } from '../../../../shared/local-workflow-draft'

/** One seat as the roster rules see it; `mayJudge` is false for Gemini (never ranks or chairs). */
export type CouncilRosterSeat = { id: string; mayJudge: boolean }

/**
 * Council revision 6 role rules, shared by draft admission and the program so a draft admitted at
 * Start can never be refused by the running program. Unplaceable model families are refused when
 * the host resolves the lineup, so Gemini is the only seat that can fail `mayJudge` here.
 */
export function councilRosterProblem(input: {
  memberIds: readonly string[]
  chairId: string
  seats: readonly CouncilRosterSeat[]
}): string | undefined {
  const { memberIds } = input
  if (memberIds.length < COUNCIL_MIN_MEMBERS || memberIds.length > COUNCIL_MAX_MEMBERS) {
    return `Choose ${COUNCIL_MIN_MEMBERS} to ${COUNCIL_MAX_MEMBERS} council members.`
  }
  if (new Set(memberIds).size !== memberIds.length) {
    return 'Choose each council member once.'
  }
  const seat = (id: string) => input.seats.find((candidate) => candidate.id === id)
  const members = memberIds.map(seat)
  if (members.some((member) => !member)) {
    return 'A council member is no longer set up. Choose the members again.'
  }
  const chair = seat(input.chairId)
  if (!input.chairId.trim() || !chair) {
    return 'Choose a chairman.'
  }
  if (!chair.mayJudge) {
    return 'Gemini answers but never chairs. Choose another chairman.'
  }
  if (!members.some((member) => member?.mayJudge)) {
    return 'Add a member other than Gemini: Gemini answers but never ranks.'
  }
  return undefined
}
