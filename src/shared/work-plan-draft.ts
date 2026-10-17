import { workPlanFromChain } from './work-plan-read'
import { emptyNextStepDraft, type NextStepDraft, type NextStepOutcomeStep } from './next-step-draft'
import { workPlanNodeInstruction } from './work-plan-instruction'
import { workPlanProblems } from './work-plan-validate'
import {
  WORK_PLAN_ROLE_PRESET,
  workPlanNodeActors,
  workPlanNodeGroup,
  workPlanProducers,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanProblem,
  workPlanOutcomeOf
} from './work-plan-types'
const block = (code: string, message: string, nodeId?: string): WorkPlanProblem => ({
  code,
  message,
  nodeId,
  severity: 'block'
})

export function workPlanDraft(
  plan: WorkPlan,
  ctx: WorkPlanContext
): { draft: NextStepDraft; problems: WorkPlanProblem[] } {
  const draft = emptyNextStepDraft()
  const problems = workPlanProblems(plan, ctx)
  const finish = plan.nodes.find((node) => node.kind === 'finish')
  const old = ctx.existingChain
  const id =
    workPlanOutcomeOf(plan).outcomeId ?? old?.outcomeSet?.outcomes[0]?.id ?? draft.outcomes![0]!.id
  const priorNodes = old?.outcomeSet ? workPlanFromChain(old).nodes : []
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
        : entry
    )
  const known = new Set(
    priorNodes
      .filter((prior) => plan.nodes.some((node) => stable(node) === stable(prior)))
      .map((node) => node.id)
  )
  const steps: NextStepOutcomeStep[] = []
  for (const node of plan.nodes) {
    if (node.kind === 'finish' || known.has(node.id)) {
      continue
    }
    const instruction = workPlanNodeInstruction(plan, node)
    if (node.kind === 'review') {
      if (node.stop !== 'zero_blockers') {
        problems.push(
          block(
            'review-stop-unsupported',
            'The existing review-round primitive stops on zero blockers; choose that stop rule.',
            node.id
          )
        )
      }
      const producer = workPlanProducers(plan, node).at(-1)
      if (!producer || producer.kind === 'finish') {
        continue
      }
      if (workPlanOutcomeOf(plan).outputKind !== 'work' && node.maxRounds > 1) {
        problems.push(
          block(
            'plan-loop-repair',
            'Plan-only review loops cannot repair the workspace; choose one round.',
            node.id
          )
        )
      }
      steps.push({
        id: node.id,
        kind: 'review',
        reviewers: workPlanNodeActors(node),
        maxRounds: node.maxRounds,
        instructions: instruction,
        adversarial: node.loop === 'adversarial'
      })
      if (node.maxRounds > 1) {
        steps.push({
          id: `${node.id}_repair`,
          kind: 'handoff',
          actor: producer.actor,
          presetId: 'repair',
          instructions: workPlanNodeInstruction(plan, {
            kind: 'worker',
            id: `${node.id}_repair`,
            role: 'repair',
            actor: producer.actor,
            instruction: ''
          }),
          reviewRepair: true
        })
      }
    } else {
      workPlanNodeActors(node).forEach((actor, index) =>
        steps.push({
          id: `${node.id}_seat_${index + 1}`,
          kind: 'handoff',
          actor,
          presetId: WORK_PLAN_ROLE_PRESET[node.role],
          instructions: instruction,
          ...(workPlanNodeGroup(node) ? { parallelGroup: workPlanNodeGroup(node) } : {})
        })
      )
    }
  }
  draft.end = finish?.kind === 'finish' && finish.how === 'complete' ? 'done' : 'me'
  draft.handoff.sourceConversationId = plan.source?.conversationId
  const people = finish?.kind === 'finish' ? finish.finishWith : undefined
  if (people && !people.people.length) {
    problems.push(block('finish-needs-person', 'Choose the person this goes to.', finish!.id))
  }
  if (people?.people.length) {
    draft.handoff = {
      ...draft.handoff,
      ...(people.receive?.taskId
        ? { task: { id: people.receive.taskId, title: workPlanOutcomeOf(plan).title } }
        : {}),
      includeSummary: people.receive?.files !== false,
      ...(people.receive?.transcript ? { includeTranscript: true } : {}),
      ...(people.receive?.dueAt ? { dueAt: people.receive.dueAt } : {}),
      ...(people.receive?.artifact ? { artifactReview: { ...people.receive.artifact } } : {}),
      ...(people.action ? { action: people.action } : {})
    }
    draft.note = people.receive?.note ?? draft.note
    if (people.receive?.note?.trim()) {
      draft.noteAuthored = true
    }
  }
  draft.outcomes = [
    {
      id,
      revision: workPlanOutcomeOf(plan).revision,
      finish:
        people?.people.length && people.people[0]
          ? {
              kind: 'person',
              personId: people.people[0].id,
              personName: people.people[0].name,
              ...(people.people.length > 1 ? { people: people.people.slice(1) } : {}),
              disposition: people.disposition,
              action: people.action ?? (people.disposition === 'feedback' ? 'review' : 'edit')
            }
          : { kind: finish?.kind === 'finish' ? finish.how : 'my-review' },
      instructions: workPlanOutcomeOf(plan).title,
      steps
    }
  ]
  return { draft, problems }
}
