import {
  councilFinalCheckSteps,
  decideCouncilFinalCheck,
  type CouncilFinalCheck
} from '../../../../shared/workflow-council-final-check'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import {
  arrangeImproveLineup,
  decideImproveRound,
  type ImproveVersion
} from './graph-improve-decide'
import { graphJudgesCompareEveryPair, graphLabel } from './graph-parse'
import { graphJevCallId } from './graph-step-calls'
import { graphDoneCallIds, type GraphCandidate, type GraphStepRun } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { runGraphStep } from './graph-step'

/** The ranked step's best-placed answer: the top first opinion, or Decide's best finalist. */
export function finalCheckDefender(scope: GraphScope, rankId: string) {
  const peer = scope.runs[rankId][0]
  const top = (peer.standings ?? [])
    .filter((row) => row.votes > 0)
    .sort((a, b) => a.place - b.place || a.label.localeCompare(b.label))[0]
  return { top, first: peer.candidates?.find((candidate) => candidate.label === top?.label) }
}

/** The chair stays the sink; its protected comparison reuses the rankers in round two. */
export function settleCouncilFinalCheck(
  scope: GraphScope,
  step: WorkflowStep,
  chair: GraphStepRun
): void {
  const check = councilFinalCheckSteps(scope.config.spec)
  const answer = chair.texts?.[0]
  if (!check || step.id !== check.chair.id || !answer || chair.state === 'active') {
    return
  }
  const finish = (
    result: CouncilFinalCheck['result'],
    judgedBy: CouncilFinalCheck['judgedBy'] = []
  ) => {
    chair.finalCheck = {
      result,
      judgedBy,
      ...(check.rank.byCriterion ? { subject: 'decide' as const } : {})
    }
  }
  const prefix = `${check.rank.id}/r2/`
  const started = [...scope.outcomes.keys()].some((id) => id.startsWith(prefix))
  // Round 2 always forces `jev: { only: true }` below, so its real first call is the JEV
  // ballot, never an agent's `a0` — probe the id that will actually be built.
  const firstCallId = graphJevCallId(check.rank, 2, true)
  if (!started && scope.config.refused?.(firstCallId)) {
    finish('finished-early')
    return
  }
  const { top, first } = finalCheckDefender(scope, check.rank.id)
  if (!first) {
    // A vote was counted but its label does not resolve to a candidate: that is a broken
    // ranking, not an empty one — report it as a failure, never as "no votes".
    finish(top ? 'failed' : 'no-peer-votes')
    return
  }
  const defender: ImproveVersion = {
    text: { ...first, agentIndex: first.source?.agentIndex ?? 0, callId: '' },
    round: 1,
    role: 'best'
  }
  const challenger: ImproveVersion = { text: answer, round: 2, role: 'improve' }
  const lineup = arrangeImproveLineup(defender, [challenger], 2)
  const candidates: GraphCandidate[] = lineup.map((version, index) => ({
    label: graphLabel(index),
    seatId: version.text.seatId,
    name: version.text.name,
    markdown: version.text.markdown,
    ...(version === defender
      ? { incumbent: true as const, source: first.source }
      : {
          source: { stepId: step.id, agentIndex: answer.agentIndex }
        })
  }))
  const judge = runGraphStep(
    scope,
    {
      ...check.rank,
      inputs: [step.id],
      jev: { method: 'auto', only: true }
    },
    2,
    {
      inLoop: true,
      candidates,
      decisionPoint: 'final-check',
      overrides: new Map([
        [step.id, { status: 'ok', run: chair, callIds: graphDoneCallIds(chair) }]
      ])
    }
  )
  scope.runs[check.rank.id].push(judge)
  if (judge.state === 'active' || judge.state === 'waiting') {
    chair.state = 'active'
    return
  }
  if (judge.calls.some((call) => call.skipped)) {
    finish('finished-early')
    return
  }
  const counted = (judge.standings ?? []).filter((row) => row.votes > 0)
  if (judge.state === 'failed' || judge.state === 'not-run' || !counted.length) {
    finish('failed')
    return
  }
  const decision = decideImproveRound(lineup, candidates, judge, defender)
  const modelVoted = judge.calls.some((call) => !call.jev && call.ranking)
  // Unsure means JEV produced a ballot it doubted; failed means it produced no ballot at all —
  // the two are not the same, and only the first should ever credit JEV alongside the models.
  const jevFailed = judge.calls.find((call) => call.jev)?.status === 'failed'
  const verdict = decideCouncilFinalCheck({
    decisiveVotes: counted.length === 2 && counted[0].place !== counted[1].place,
    defenderWon: lineup[decision.index] === defender,
    unjudged: !!decision.unjudged,
    modelVoted,
    jevUnsure: !!judge.jevUnsure,
    jevFailed,
    everyPairJudged: graphJudgesCompareEveryPair(
      candidates,
      judge.calls.filter((call) => !call.jev && call.ranking).map((call) => call.seatId)
    )
  })
  // Ship purely off `winner` (never a separate `decisive` branch): decideCouncilFinalCheck
  // already guarantees winner === 'challenger' whenever the check was not decisive, so this is
  // exactly the seam a future NOUL decider would be judged against.
  if (verdict.winner === 'defender') {
    chair.finalCheckAnswer = first.markdown
  }
  finish(
    !verdict.decisive ? 'inconclusive' : verdict.winner === 'defender' ? 'first-opinion' : 'chair',
    verdict.judgedBy
  )
}
