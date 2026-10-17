import type {
  LocalWorkflowCallView,
  LocalWorkflowCouncilRun,
  LocalWorkflowSeatView,
  LocalWorkflowView
} from '../../../shared/local-workflow-view'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import { localWorkflowModelLabel } from '../../../shared/local-workflow-model-label'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { COUNCIL_REVISION } from './workflow-program-revisions'
import {
  aggregateCouncilBallots,
  validateCouncilBallot,
  type CouncilBallot
} from './presets/council'
import {
  councilMarkdown,
  councilMayRank,
  councilMemberLabel,
  councilRankFromLegacyScore,
  councilSeatNames,
  councilStreetCred,
  parseCouncilRanking,
  placeCouncilStandings
} from './presets/council-ranking'

const responseLabel = (index: number): string => `Response ${String.fromCharCode(65 + index)}`
const providerLabel = (agent: string): string =>
  agent === 'codex' ? 'Codex' : agent === 'grok' ? 'Grok' : 'Claude'

/** Projects accepted ballots only; incomplete reviews never imply an aggregate rank. */
export function projectCouncilEvidence(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>
): NonNullable<LocalWorkflowView['council']> {
  const reviews: NonNullable<LocalWorkflowView['council']>['reviews'] = []
  const ballots: CouncilBallot[] = []
  snapshot.seats.forEach((seat, index) => {
    const value = results.get(`peer/${seat.id}`)
    if (value === undefined) {
      return
    }
    const expected = snapshot.seats.flatMap((_, other) =>
      other === index ? [] : [snapshot.councilBlindLabels?.[other] ?? responseLabel(other)]
    )
    const error = validateCouncilBallot(value, expected)
    if (error) {
      throw new Error(`Accepted Council ballot is invalid: ${error}`)
    }
    const ballot = value as CouncilBallot
    ballots.push(ballot)
    reviews.push({
      reviewer: providerLabel(seat.agent),
      ranking: ballot.ranking,
      assessments: ballot.assessments
    })
  })
  if (ballots.length !== snapshot.seats.length) {
    return { reviews, ranking: [] }
  }
  const labels = snapshot.seats.map(
    (_, index) => snapshot.councilBlindLabels?.[index] ?? responseLabel(index)
  )
  const ranking = aggregateCouncilBallots(ballots, labels).map((entry) => {
    const index = labels.indexOf(entry.label)
    return {
      ...entry,
      model: providerLabel(snapshot.seats[index].agent)
    }
  })
  return { reviews, ranking }
}

export type LocalWorkflowStageDefinition = {
  id: string
  label: string
  total?: number
  summary?: string
}

function seatView(seat: ResolvedLocalWorkflowSeat): LocalWorkflowSeatView {
  return {
    seatId: seat.id,
    agent: seat.agent,
    model: seat.model,
    modelLabel: localWorkflowModelLabel(seat.agent, seat.model),
    effort: seat.effort
  }
}

/** Revision 6 members in frozen order; labels follow member order even if a seat is missing. */
function karpathyMembers(snapshot: LocalWorkflowHostSnapshot) {
  return (snapshot.council?.memberIds ?? []).flatMap((seatId, index) => {
    const seat = snapshot.seats.find((candidate) => candidate.id === seatId)
    return seat ? [{ seat, label: councilMemberLabel(index) }] : []
  })
}

/**
 * Revision 6 member names by seat id, numbered as the program numbers them, so a repeated model
 * reads the same on every card, label and call. A seat outside the council, or a legacy run,
 * keeps the plain model name.
 */
export function councilSeatModelLabels(
  snapshot: LocalWorkflowHostSnapshot
): ReadonlyMap<string, string> {
  if (snapshot.councilProgramRevision !== COUNCIL_REVISION) {
    return new Map()
  }
  const found = karpathyMembers(snapshot)
  const names = councilSeatNames(found.map(({ seat }) => seat))
  return new Map(found.map(({ seat }, index) => [seat.id, names[index]]))
}

/** Stage rail for Council runs; the stage id is the call-id prefix. */
export function councilStageDefinitions(
  snapshot: LocalWorkflowHostSnapshot,
  _results: ReadonlyMap<string, unknown>
): LocalWorkflowStageDefinition[] {
  if (snapshot.councilProgramRevision === COUNCIL_REVISION) {
    const members = karpathyMembers(snapshot)
    return [
      { id: 'answer', label: 'First opinions', total: members.length },
      {
        id: 'rank',
        label: 'Peer rankings',
        total: members.filter((member) => councilMayRank(member.seat)).length
      },
      { id: 'chair', label: "Chairman's answer", total: 1 }
    ]
  }
  return [
    { id: 'answers', label: 'Answers', total: 3, summary: 'Three independent answers' },
    { id: 'peer', label: 'Peer review', total: 3, summary: 'Three other-only peer reviews' },
    { id: 'synthesis', label: 'Synthesis', total: 1, summary: 'One combined answer' }
  ]
}

function projectKarpathy(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>
): Pick<LocalWorkflowCouncilRun, 'members' | 'ballots' | 'standings'> {
  // The program's names, so a repeated model reads as it does in the chairman's prompt.
  const names = councilSeatModelLabels(snapshot)
  const members = karpathyMembers(snapshot).map(({ seat, label }) => ({
    ...seatView(seat),
    modelLabel: names.get(seat.id) ?? localWorkflowModelLabel(seat.agent, seat.model),
    label,
    votes: councilMayRank(seat),
    answerCallId: `answer/${seat.id}`
  }))
  const answered = members.filter(
    (member) => councilMarkdown(results.get(member.answerCallId)) !== undefined
  )
  const labels = answered.map((member) => member.label)
  // Re-parse with the program's own parser over the labels each reviewer was shown.
  const ballots = members.flatMap((member) => {
    const callId = `rank/${member.seatId}`
    const evaluation = member.votes ? councilMarkdown(results.get(callId)) : undefined
    return evaluation === undefined
      ? []
      : [
          {
            reviewerSeatId: member.seatId,
            callId,
            evaluation,
            ranking: parseCouncilRanking(evaluation, labels)
          }
        ]
  })
  return {
    members,
    ballots,
    standings: ballots.length ? councilStreetCred(answered, ballots) : []
  }
}

/** Old structured ballots, written as the evaluation text a revision 6 reviewer would give. */
function legacyEvaluation(ballot: CouncilBallot): string {
  const assessments = ballot.assessments.map(
    (item) =>
      `#### ${item.label}\n\n**Strengths:** ${String(item.strengths)}\n\n**Weaknesses:** ${String(item.weaknesses)}`
  )
  const ranking = ballot.ranking.map((label, index) => `${index + 1}. ${label}`)
  return [...assessments, ['FINAL RANKING:', ...ranking].join('\n')].join('\n\n')
}

/**
 * Revisions 1-5: three seats that all answered and reviewed only the other two answers. The
 * working Council (revision 5) pinned shuffled blind labels at admission instead of seat order.
 */
function projectLegacy(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>
): Pick<LocalWorkflowCouncilRun, 'members' | 'ballots' | 'standings'> {
  const labels = snapshot.seats.map(
    (_, index) => snapshot.councilBlindLabels?.[index] ?? responseLabel(index)
  )
  const members = snapshot.seats.map((seat, index) => ({
    ...seatView(seat),
    label: labels[index],
    votes: true,
    answerCallId: `answers/${seat.id}`
  }))
  const valid = snapshot.seats.flatMap((seat, index) => {
    const value = results.get(`peer/${seat.id}`)
    const expected = labels.filter((_, other) => other !== index)
    return value === undefined || validateCouncilBallot(value, expected)
      ? []
      : [{ seat, ballot: value as CouncilBallot }]
  })
  const ballots = valid.map(({ seat, ballot }) => ({
    reviewerSeatId: seat.id,
    callId: `peer/${seat.id}`,
    evaluation: legacyEvaluation(ballot),
    ranking: [...ballot.ranking]
  }))
  let standings: LocalWorkflowCouncilRun['standings'] = []
  if (valid.length === snapshot.seats.length) {
    try {
      standings = placeCouncilStandings(
        aggregateCouncilBallots(
          valid.map(({ ballot }) => ballot),
          labels
        ).map((entry) => ({
          label: entry.label,
          seatId: snapshot.seats[labels.indexOf(entry.label)].id,
          averageRank: councilRankFromLegacyScore(entry.score),
          votes: entry.votes
        }))
      )
    } catch {
      // A legacy panel that is not exactly three seats has no aggregate; show ballots only.
    }
  }
  return { members, ballots, standings }
}

/** Revision-independent Council view; a malformed ballot is skipped, never thrown. */
export function projectCouncilRun(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>,
  _calls: readonly LocalWorkflowCallView[]
): LocalWorkflowCouncilRun | undefined {
  const chair = snapshot.seats.find((seat) => seat.id === snapshot.synthesizerId)
  const run =
    snapshot.councilProgramRevision === COUNCIL_REVISION
      ? projectKarpathy(snapshot, results)
      : projectLegacy(snapshot, results)
  const view = chair && seatView(chair)
  const member = run.members.find((entry) => entry.seatId === chair?.id)
  return {
    ...run,
    // A chairman who is also a member keeps that member's name.
    ...(view ? { chair: { ...view, modelLabel: member?.modelLabel ?? view.modelLabel } } : {}),
    selfVotesExcluded: true
  }
}

/** Final answer markdown for Save/Copy; undefined until the final call is accepted. */
export function councilResultMarkdown(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>
): string | undefined {
  if (snapshot.councilProgramRevision === COUNCIL_REVISION) {
    return councilMarkdown(results.get('chair/final'))
  }
  const final = results.get('synthesis/final')
  if (final === undefined) {
    return undefined
  }
  return final &&
    typeof final === 'object' &&
    'markdown' in final &&
    typeof final.markdown === 'string'
    ? final.markdown
    : `\`\`\`json\n${JSON.stringify(final, null, 2)}\n\`\`\``
}
