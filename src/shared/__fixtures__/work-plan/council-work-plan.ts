import type { WorkPlan, WorkPlanNode } from '../../work-plan-types'
import { WORK_PLAN_FIXTURE_ACTORS } from './work-plan-context'

const { claude, codex, grok, kimi } = WORK_PLAN_FIXTURE_ACTORS
const SEATS = [
  { id: 'a', actor: claude },
  { id: 'b', actor: codex },
  { id: 'c', actor: grok }
]

/**
 * Council, lowered the way the engine can run it: N answers in their own output folders, then
 * N critiques that each read the OTHER answers and record a verdict, then one judge from a
 * fourth family. No review round is involved — a review round is one round over one candidate.
 */
export function councilWorkPlan(): WorkPlan {
  const answers: WorkPlanNode[] = SEATS.map((seat) => ({
    kind: 'worker',
    id: `answer-${seat.id}`,
    role: 'implement',
    instruction: 'Answer the request on your own, without reading the other answers.',
    actor: seat.actor,
    group: 'answers',
    writes: 'own-output-dir'
  }))
  const critiques: WorkPlanNode[] = SEATS.map((seat) => {
    const others = SEATS.filter((entry) => entry.id !== seat.id).map(
      (entry) => `answer-${entry.id}`
    )
    return {
      kind: 'worker',
      id: `critique-${seat.id}`,
      role: 'critique',
      instruction: '',
      actor: seat.actor,
      group: 'critiques',
      readsFrom: others,
      verdict: { kind: 'critique', over: others, consumed: 'record' }
    }
  })
  const answerIds = answers.map((node) => node.id)
  return {
    outcome: {
      title: 'Council on the pricing question',
      outputKind: 'work',
      doneWhen: [
        {
          id: 'dw-answer',
          text: 'one answer is chosen with the reasons it won',
          evidence: 'verdict'
        }
      ]
    },
    nodes: [
      ...answers,
      ...critiques,
      {
        kind: 'worker',
        id: 'council-judge',
        role: 'judge',
        instruction: '',
        actor: kimi,
        readsFrom: [...answerIds, ...critiques.map((node) => node.id)],
        verdict: { kind: 'judge', over: answerIds, consumed: 'select-winner' }
      },
      {
        kind: 'worker',
        id: 'winner',
        role: 'synthesize',
        instruction: '',
        actor: claude,
        readsFrom: ['council-judge'],
        readsWinnerOf: 'council-judge'
      },
      { kind: 'finish', id: 'me', how: 'my-review', route: 'human' }
    ]
  }
}
