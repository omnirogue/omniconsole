import { WORK_PLAN_READ_ONLY_ROLES } from './work-plan-types'
import type { SessionChainStepStage } from './session-chain-types'
import { mayIssueVerdict, modelLineage } from './model-lineage'
import { workPlanProblems } from './work-plan-validate'
import type {
  WorkPlan,
  WorkPlanActor,
  WorkPlanContext,
  WorkPlanNode,
  WorkPlanOutcome,
  WorkPlanRole,
  WorkPlanWorkerNode
} from './work-plan-types'

export type WorkPlanShape =
  | 'solo'
  | 'parallel'
  | 'sequential'
  | 'council'
  | 'bestOfN'
  | 'synthesis'
  | 'reviewLoop'
  | 'savedWorkflow'
  | 'custom'
export const WORK_PLAN_SHAPES: readonly WorkPlanShape[] = [
  'solo',
  'parallel',
  'sequential',
  'council',
  'bestOfN',
  'synthesis',
  'reviewLoop',
  'savedWorkflow',
  'custom'
]

export function workPlanShapeActors(ctx: WorkPlanContext): WorkPlanActor[] {
  const actors = ctx.usableAgents.flatMap<WorkPlanActor>(({ agent, models }) =>
    models.length
      ? models.map((model) => ({
          agent,
          model: model.id,
          ...(model.efforts[0] ? { effort: model.efforts[0] } : {})
        }))
      : [{ agent }]
  )
  const families = new Set<string>()
  return [
    ...actors.filter((actor) => {
      const family = modelLineage(actor.agent, actor.model)
      if (families.has(family)) {
        return false
      }
      families.add(family)
      return true
    }),
    ...actors.filter(
      (actor, index) =>
        actors.findIndex(
          (entry) =>
            modelLineage(entry.agent, entry.model) === modelLineage(actor.agent, actor.model)
        ) !== index
    )
  ]
}

export function shapeAvailable(
  shape: WorkPlanShape,
  ctx: WorkPlanContext
): { ok: boolean; reason?: string } {
  if (shape === 'savedWorkflow' || shape === 'custom') {
    return {
      ok: false,
      reason:
        shape === 'savedWorkflow'
          ? 'Saved workflows are supplied by the workflow library.'
          : 'Custom plans are authored in the work-plan dialog.'
    }
  }
  const actors = workPlanShapeActors(ctx)
  if (!actors.length) {
    return { ok: false, reason: 'No usable agent on this execution host.' }
  }
  const deciding = actors.filter((a) => mayIssueVerdict(a.agent, a.model))
  if (
    ['council', 'bestOfN'].includes(shape) &&
    new Set(deciding.map((a) => modelLineage(a.agent, a.model))).size < 2
  ) {
    return {
      ok: false,
      reason: 'This shape needs a judge from a different family than every candidate.'
    }
  }
  if (shape === 'reviewLoop' && !deciding.length) {
    return { ok: false, reason: 'Review Loop needs an agent allowed to issue a verdict.' }
  }
  return { ok: true }
}

/** Seats a fan-out shape mints when the person did not say; the composer's own default. */
export const WORK_PLAN_DEFAULT_SHAPE_SEATS = 3

/** Authoring may leave content incomplete; execution still requires workPlanFromShape or commit validation. */
export function workPlanDraftFromShape(
  shape: WorkPlanShape,
  input: {
    prompt: string
    outcome: WorkPlanOutcome
    planMode: boolean
    ctx: WorkPlanContext
    /** How wide the person asked this stage to be; 3 when they did not say. */
    seats?: number
    /** Marks every node this one shape mints, so it stays ONE stage for the person. */
    stage?: SessionChainStepStage
  }
): WorkPlan {
  const available = shapeAvailable(shape, input.ctx)
  if (!available.ok) {
    throw new Error(available.reason)
  }
  const actors = workPlanShapeActors(input.ctx)
  const first = actors[0]!
  const width = Math.max(2, Math.min(9, Math.trunc(input.seats ?? WORK_PLAN_DEFAULT_SHAPE_SEATS)))
  const outcome: WorkPlanOutcome = {
    ...input.outcome,
    doneWhen: input.outcome.doneWhen.map((d) => ({ ...d })),
    ...(input.planMode ? { outputKind: 'plan' } : {})
  }
  if (input.planMode && !outcome.doneWhen.length) {
    outcome.doneWhen.push({
      id: 'plan-file',
      text: 'The plan document matches work-plan-v1',
      evidence: 'file',
      path: 'plan.json'
    })
  }
  const role: WorkPlanRole = outcome.outputKind === 'work' ? 'implement' : 'plan'
  const nodes: WorkPlanNode[] = []
  const worker = (
    id: string,
    action: WorkPlanRole,
    actor: WorkPlanActor,
    readsFrom: string[] = []
  ): WorkPlanWorkerNode => ({
    kind: 'worker',
    id,
    role: action,
    actor,
    instruction: '',
    readsFrom,
    writes: (WORK_PLAN_READ_ONLY_ROLES as readonly string[]).includes(action)
      ? 'own-output-dir'
      : 'workspace'
  })
  const base = worker('work', role, first)
  base.instruction = `${input.prompt}\n\nWork toward {{outcome.title}}. Done When: {{doneWhen}}.`
  if (shape === 'solo' || shape === 'reviewLoop') {
    nodes.push(base)
  } else if (shape === 'sequential') {
    nodes.push(
      { ...base, role: input.planMode ? 'plan' : 'research', writes: 'own-output-dir' },
      worker('plan', 'plan', actors[1] ?? first, ['work']),
      worker('result', role, first, ['plan'])
    )
  } else if (shape === 'council' || shape === 'bestOfN') {
    const eligible = actors.filter((actor) => mayIssueVerdict(actor.agent, actor.model))
    const judge = eligible.at(-1)!
    const candidates = eligible.filter(
      (actor) => modelLineage(actor.agent, actor.model) !== modelLineage(judge.agent, judge.model)
    )
    const seats = Array.from({ length: width }, (_, i) => candidates[i % candidates.length]!)
    const answers = seats.map((actor, index) => ({
      ...base,
      id: `answer-${index + 1}`,
      actor,
      group: 'answers',
      writes: 'own-output-dir' as const
    }))
    nodes.push(...answers)
    const answerIds = answers.map((node) => node.id)
    const critiqueIds: string[] = []
    if (shape === 'council') {
      seats.forEach((actor, index) => {
        const others = answerIds.filter((_, i) => i !== index)
        const critique = worker(`critique-${index + 1}`, 'critique', actor, others)
        critique.group = 'critiques'
        critique.verdict = { kind: 'critique', over: others, consumed: 'record' }
        nodes.push(critique)
        critiqueIds.push(critique.id)
      })
    }
    nodes.push(
      {
        ...worker('judge', 'judge', judge, [...answerIds, ...critiqueIds]),
        verdict: { kind: 'judge', over: answerIds, consumed: 'select-winner' }
      },
      { ...worker('winner', 'synthesize', first, ['judge']), readsWinnerOf: 'judge' }
    )
  } else {
    nodes.push({
      ...base,
      writes: 'own-output-dir',
      count: width,
      seats: Array.from({ length: width }, (_, i) => actors[i % actors.length]!)
    })
    if (shape === 'synthesis') {
      nodes.push(worker('synthesis', 'synthesize', first, ['work']))
    }
  }
  if (shape === 'reviewLoop') {
    nodes.push({
      kind: 'review',
      id: 'review',
      actor: actors.find((a) => mayIssueVerdict(a.agent, a.model))!,
      readsFrom: ['work'],
      loop: 'review',
      maxRounds: outcome.outputKind === 'work' ? 2 : 1,
      stop: 'zero_blockers',
      verdict: { kind: 'review', over: ['work'], consumed: 'gate' }
    })
  }
  const checks = outcome.doneWhen.filter((d) => d.evidence === 'verdict' || d.evidence === 'report')
  if (checks.length) {
    const actor = actors.find((a) => mayIssueVerdict(a.agent, a.model))
    if (!actor) {
      throw new Error('Done When requires an agent allowed to Verify.')
    }
    nodes.push({
      ...worker('verify', 'verify', actor, [nodes.at(-1)!.id]),
      verdict: { kind: 'verify', over: checks.map((d) => d.id), consumed: 'gate' }
    })
  }
  nodes.push({
    kind: 'finish',
    id: 'finish',
    how: outcome.outputKind !== 'work' ? 'complete' : 'my-review'
  })
  const plan = {
    outcome,
    nodes: input.stage
      ? nodes.map((node) => (node.kind === 'finish' ? node : { ...node, stage: input.stage! }))
      : nodes
  }
  return plan
}

export function workPlanFromShape(
  shape: WorkPlanShape,
  input: Parameters<typeof workPlanDraftFromShape>[1]
): WorkPlan {
  const plan = workPlanDraftFromShape(shape, input)
  const blocks = workPlanProblems(plan, input.ctx).filter((p) => p.severity === 'block')
  if (blocks.length) {
    throw new Error(blocks.map((p) => p.message).join('\n'))
  }
  return plan
}
