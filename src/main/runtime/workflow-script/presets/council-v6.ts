import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import { localWorkflowModelLabel } from '../../../../shared/local-workflow-model-label'
import type { WorkflowProgramContext } from '../workflow-program-context'
import textAnswerSchema from './schemas/text-answer.schema.json'
import {
  councilMarkdown,
  councilMayRank,
  councilMemberLabel,
  councilNamedText,
  councilSeatNames,
  councilStreetCred,
  parseCouncilRanking,
  type CouncilStanding
} from './council-ranking'
import { councilRosterProblem } from './council-roster'
import {
  COUNCIL_RANKING_PROBLEM,
  councilAnswerPrompt,
  councilChairPrompt,
  councilRankingPrompt
} from './council-v6-prompts'

export type CouncilV6Config = {
  seats: ResolvedLocalWorkflowSeat[]
  memberIds: string[]
  chairId: string
  access: 'workspace-read' | 'frozen'
}

export type CouncilV6Answer = { seatId: string; label: string; markdown: string }
export type CouncilV6Ballot = {
  reviewerSeatId: string
  callId: string
  evaluation: string
  ranking: string[]
}
export type CouncilV6Result = {
  answers: CouncilV6Answer[]
  ballots: CouncilV6Ballot[]
  standings: CouncilStanding[]
  final: { seatId: string; markdown: string }
}

const MINUTE = 60_000
export const COUNCIL_ANSWER_TIMEOUT_MS = 15 * MINUTE
export const COUNCIL_RANK_TIMEOUT_MS = 10 * MINUTE
export const COUNCIL_CHAIR_TIMEOUT_MS = 15 * MINUTE

type Member = { seat: ResolvedLocalWorkflowSeat; label: string; name: string }

const requireText = (value: unknown): string | null =>
  councilMarkdown(value) === undefined ? 'The answer was empty.' : null

/**
 * The program's own role rules over resolved seats. The host calls this after resolving the
 * lineup so a roster the program would refuse never starts.
 */
export function councilLineupProblem(
  config: Pick<CouncilV6Config, 'seats' | 'memberIds' | 'chairId'>
): string | undefined {
  return councilRosterProblem({
    memberIds: config.memberIds,
    chairId: config.chairId,
    seats: config.seats.map((seat) => ({ id: seat.id, mayJudge: councilMayRank(seat) }))
  })
}

function councilRoles(config: CouncilV6Config) {
  const seat = (id: string) => config.seats.find((candidate) => candidate.id === id)
  const chair = seat(config.chairId)
  const problem = councilLineupProblem(config)
  if (problem || !chair) {
    throw new Error(problem ?? 'Choose a chairman.')
  }
  const seats = config.memberIds.flatMap((id) => seat(id) ?? [])
  const names = councilSeatNames(seats)
  const members: Member[] = seats.map((member, index) => ({
    seat: member,
    label: councilMemberLabel(index),
    name: names[index]
  }))
  const voters = members.filter((member) => councilMayRank(member.seat))
  const chairName =
    members.find((member) => member.seat.id === chair.id)?.name ??
    localWorkflowModelLabel(chair.agent, chair.model)
  return { members, voters, chair, chairName }
}

/**
 * Karpathy llm-council (revision 6): every member answers the question, every member that may
 * judge ranks all anonymous answers, and the chairman writes the final answer from the
 * de-anonymised record: answers and rankings under model names, never response letters. A
 * failed member or ranking degrades the run; only the chairman fails it. Once a later stage has
 * recorded a call, the checkpoint store replays a failed answer or ranking as the same null
 * (workflowSettlesSupersededCalls keys on these call ids), so Retry reruns only the chairman and
 * never changes the identity of a call already keyed on the answered set.
 */
export async function runCouncilV6Program(
  context: WorkflowProgramContext,
  config: CouncilV6Config,
  task: { prompt: string; evidence: string }
): Promise<CouncilV6Result> {
  const { members, voters, chair, chairName } = councilRoles(config)
  context.phase('First opinions')
  const answerPrompt = councilAnswerPrompt(task, config.access)
  const settledAnswers = await context.parallel(
    members.map(
      (member) => () =>
        context.agent({
          id: `answer/${member.seat.id}`,
          seatId: member.seat.id,
          schema: textAnswerSchema,
          output: 'text',
          timeoutMs: COUNCIL_ANSWER_TIMEOUT_MS,
          dependencies: [],
          prompt: answerPrompt,
          validateSemantics: requireText
        })
    )
  )
  const answered = members.flatMap((member, index) => {
    const markdown = councilMarkdown(settledAnswers[index])
    if (markdown === undefined) {
      context.log(`${member.name} did not answer; the council continues without it.`)
      return []
    }
    return [{ member, markdown }]
  })
  if (!answered.length) {
    throw new Error('No council member answered the question.')
  }
  const answers: CouncilV6Answer[] = answered.map(({ member, markdown }) => ({
    seatId: member.seat.id,
    label: member.label,
    markdown
  }))
  const labels = answers.map((answer) => answer.label)
  const answerIds = answers.map((answer) => `answer/${answer.seatId}`)

  context.phase('Peer rankings')
  const settledRankings = await context.parallel(
    voters.map((voter, index) => () => {
      // Rotate presentation order per voter to spread position bias; labels never move.
      const shift = index % answers.length
      const shown = [...answers.slice(shift), ...answers.slice(0, shift)]
      return context.agent({
        id: `rank/${voter.seat.id}`,
        seatId: voter.seat.id,
        schema: textAnswerSchema,
        output: 'text',
        timeoutMs: COUNCIL_RANK_TIMEOUT_MS,
        dependencies: answerIds,
        prompt: councilRankingPrompt(task.prompt, shown),
        validateSemantics: (value) =>
          parseCouncilRanking(councilMarkdown(value) ?? '', labels).length
            ? null
            : COUNCIL_RANKING_PROBLEM
      })
    })
  )
  const ranked = voters.flatMap((voter, index) => {
    const evaluation = councilMarkdown(settledRankings[index])
    if (evaluation === undefined) {
      context.log(`${voter.name} did not return a ranking; its vote is left out.`)
      return []
    }
    return [{ voter, evaluation }]
  })
  const ballots: CouncilV6Ballot[] = ranked.map(({ voter, evaluation }) => ({
    reviewerSeatId: voter.seat.id,
    callId: `rank/${voter.seat.id}`,
    evaluation,
    ranking: parseCouncilRanking(evaluation, labels)
  }))
  const standings = councilStreetCred(answers, ballots)
  if (!ballots.length) {
    context.log('No peer ranking came back; the chairman decides from the answers alone.')
  }

  context.phase('Chairman')
  const name = (seatId: string) =>
    members.find((member) => member.seat.id === seatId)?.name ?? seatId
  // The chairman reads model names, not the labels the reviewers were shown, and so writes them.
  const named = new Map(answered.map(({ member }) => [member.label, member.name]))
  const final = councilMarkdown(
    await context.agent({
      id: 'chair/final',
      seatId: chair.id,
      schema: textAnswerSchema,
      output: 'text',
      timeoutMs: COUNCIL_CHAIR_TIMEOUT_MS,
      dependencies: [...answerIds, ...ballots.map((ballot) => ballot.callId)],
      prompt: councilChairPrompt({
        question: task.prompt,
        answers: answered.map(({ member, markdown }) => ({ name: member.name, markdown })),
        ballots: ranked.map(({ voter, evaluation }) => ({
          name: voter.name,
          evaluation: councilNamedText(evaluation, named)
        })),
        standings: standings.map((standing) => ({ ...standing, name: name(standing.seatId) })),
        access: config.access
      }),
      validateSemantics: requireText
    })
  )
  if (final === undefined) {
    throw new Error(`${chairName} returned an empty final answer.`)
  }
  return { answers, ballots, standings, final: { seatId: chair.id, markdown: final } }
}
