import { workPlanFromShape, shapeAvailable, type WorkPlanShape } from './work-plan-shapes'
import { workPlanProblems } from './work-plan-validate'
import type { SessionChainStepStage } from './session-chain-types'
import type {
  NextOutcomeTeamUsableAgent,
  NextOutcomeTeamUsableModel
} from './next-outcome-team-plan-schema'
import {
  workPlanNodeSeatCount,
  type WorkPlan,
  type WorkPlanActor,
  type WorkPlanContext,
  type WorkPlanRole,
  type WorkPlanRoute,
  workPlanOutcomeOf
} from './work-plan-types'

export type WorkPlanFragment = {
  action: WorkPlanRole
  topology: WorkPlanShape
  route: WorkPlanRoute
  actor: WorkPlanActor
  actors?: WorkPlanActor[]
  instruction?: string
  /** How wide the person asked this stage to be; the shape's own default when absent. */
  seats?: number
  /** The composer stage every node of this fragment belongs to. */
  stage?: SessionChainStepStage
  /**
   * The nodes this fragment reads, when the person named them. Absent reads the anchor and its
   * group, which is what "after this stage" means; naming them is the Advanced reads-from row.
   */
  readsFrom?: string[]
}

/**
 * One catalogue entry per AGENT, with every model it may launch under.
 *
 * Merged rather than listed: the seat validator answers "can this host launch this?" with
 * `usableAgents.find(agent)` — the FIRST entry for that agent — so two entries for one agent
 * hide each other's models, and the seat the person explicitly chose reads as not usable.
 */
export function workPlanUsableAgents(
  actors: readonly WorkPlanActor[]
): NextOutcomeTeamUsableAgent[] {
  const merged: NextOutcomeTeamUsableAgent[] = []
  for (const actor of actors) {
    const known = merged.find((entry) => entry.agent === actor.agent)
    const models: NextOutcomeTeamUsableModel[] = known?.models ?? []
    if (!known) {
      merged.push({ agent: actor.agent, models })
    }
    if (!actor.model) {
      continue
    }
    const model = models.find((entry) => entry.id === actor.model)
    if (!model) {
      models.push({
        id: actor.model,
        label: actor.model,
        efforts: actor.effort ? [actor.effort] : []
      })
      continue
    }
    if (actor.effort && !model.efforts.includes(actor.effort)) {
      model.efforts.push(actor.effort)
    }
  }
  return merged
}

/**
 * The verdict a deciding stage owes, decided by what the plan does with it.
 *
 * Brief 54 (binding): "Review/Verify/Judge keep their verdict contracts (`verdict.kind`,
 * `consumed`, `over`, OMNI_VERDICT)". A Review or an Adversarial review compiles from the
 * plain worker primitive, which carried no verdict at all — so no OMNI_VERDICT suffix was
 * emitted, nothing it decided was consumed, and its verdict badge could never fill. It gets
 * one here, over exactly the work it reads.
 *
 * The other half of the contract is that a verdict nobody spends never runs (frozen model §1;
 * validator `verdict-unconsumed`): a RECORDED verdict is spent by a later stage naming it in
 * what it reads. A review that ends the track has no reader, so it reports its findings in
 * prose instead of claiming a contract the host could not consume. Idempotent, and applied to
 * the whole plan, because having a reader is a fact about the plan rather than about a stage.
 */
export function workPlanRoleVerdicts(plan: WorkPlan): WorkPlan {
  const read = (id: string, index: number): boolean =>
    plan.nodes
      .slice(index + 1)
      .some((node) => node.kind !== 'finish' && node.readsFrom?.includes(id))
  return {
    ...plan,
    nodes: plan.nodes.map((node, index) => {
      if (node.kind !== 'worker' || !['review', 'critique'].includes(node.role)) {
        return node
      }
      const over = node.verdict?.over ?? node.readsFrom ?? []
      if (!read(node.id, index) || !over.length) {
        if (node.verdict?.consumed !== 'record') {
          return node
        }
        const { verdict: _unspent, ...rest } = node
        return rest
      }
      return {
        ...node,
        verdict: node.verdict ?? {
          kind: node.role === 'critique' ? 'critique' : 'review',
          over: [...over],
          consumed: 'record'
        }
      }
    })
  }
}

export function appendWorkPlanFragment(
  plan: WorkPlan,
  anchorNodeId: string,
  fragment: WorkPlanFragment
): WorkPlan {
  const index = plan.nodes.findIndex((node) => node.id === anchorNodeId)
  const anchor = plan.nodes[index]
  if (!anchor || anchor.kind === 'finish') {
    throw new Error('Choose an agent stage to extend.')
  }
  const candidates = plan.nodes.filter(
    (node) =>
      node.id === anchor.id ||
      (anchor.kind === 'worker' &&
        anchor.group &&
        node.kind === 'worker' &&
        node.group === anchor.group)
  )
  if (
    ['judge', 'synthesize'].includes(fragment.action) &&
    candidates.reduce((n, node) => n + workPlanNodeSeatCount(node), 0) < 2
  ) {
    throw new Error('Judge and Synthesize need at least two candidates.')
  }
  const actors = [
    fragment.actor,
    ...(fragment.actors ?? []).filter(
      (actor) => actor.agent !== fragment.actor.agent || actor.model !== fragment.actor.model
    )
  ]
  const ctx: WorkPlanContext = {
    usableAgents: workPlanUsableAgents(actors),
    source: null,
    placement: 'local',
    accountCatalogue: [],
    commitSource: 'user',
    capabilities: { sameConversationRoute: false }
  }
  let serial = 1
  while (plan.nodes.some((node) => node.id.startsWith(`next-${serial}-`))) {
    serial++
  }
  const created = workPlanFromShape(fragment.topology, {
    prompt: fragment.instruction ?? '',
    outcome: { ...workPlanOutcomeOf(plan), outputKind: 'work', doneWhen: [] },
    planMode: false,
    ctx,
    ...(fragment.seats !== undefined ? { seats: fragment.seats } : {}),
    stage: fragment.stage ?? {
      id: `stage-${serial}`,
      shape: fragment.topology === 'bestOfN' ? 'best-of' : 'solo',
      width: Math.max(1, Math.trunc(fragment.seats ?? 1))
    }
  })
  const rename = (id: string): string => `next-${serial}-${id}`
  const named = (fragment.readsFrom ?? []).filter((id) =>
    plan.nodes.some((node) => node.id === id && node.kind !== 'finish')
  )
  const reads = named.length ? [...new Set(named)] : candidates.map((node) => node.id)
  const additions = created.nodes
    .filter((node) => node.kind !== 'finish')
    .map((node) => {
      const initial = !node.readsFrom?.length
      const next = {
        ...node,
        id: rename(node.id),
        route: fragment.route === 'human' ? ('new-session' as const) : fragment.route,
        readsFrom: initial ? reads : node.readsFrom!.map(rename),
        ...(node.verdict
          ? { verdict: { ...node.verdict, over: node.verdict.over.map(rename) } }
          : {})
      }
      if (next.kind === 'worker') {
        if (initial) {
          next.role = fragment.action
          next.instruction = fragment.instruction ?? ''
        }
        if (next.group) {
          next.group = rename(next.group)
        }
        if (next.readsWinnerOf) {
          next.readsWinnerOf = rename(next.readsWinnerOf)
        }
        if (initial && fragment.action === 'judge') {
          next.verdict = { kind: 'judge', over: reads, consumed: 'select-winner' }
        }
        if (initial && fragment.action === 'verify') {
          next.verdict = {
            kind: 'verify',
            over: workPlanOutcomeOf(plan).doneWhen.map((d) => d.id),
            consumed: 'gate'
          }
        }
      }
      return next
    })
  if (fragment.action === 'judge' && fragment.topology === 'solo') {
    additions.push({
      kind: 'worker',
      id: rename('winner'),
      role: 'synthesize',
      actor: fragment.actor,
      instruction: '',
      readsFrom: [additions[0]!.id],
      readsWinnerOf: additions[0]!.id,
      writes: 'own-output-dir',
      route: 'new-session'
    })
  }
  const insertion = Math.max(...candidates.map((node) => plan.nodes.indexOf(node))) + 1
  const nodes = [
    ...plan.nodes.slice(0, insertion),
    ...additions,
    ...plan.nodes.slice(insertion)
  ].map((node) =>
    node.kind === 'finish' && fragment.route === 'human'
      ? { ...node, how: 'my-review' as const, route: 'human' as const }
      : node
  )
  return workPlanRoleVerdicts({ ...plan, nodes })
}

export function fragmentAvailable(
  plan: WorkPlan,
  anchorNodeId: string,
  fragment: WorkPlanFragment,
  ctx: WorkPlanContext
): { ok: boolean; reason?: string } {
  const shape = shapeAvailable(fragment.topology, ctx)
  if (!shape.ok) {
    return shape
  }
  try {
    const proposed = appendWorkPlanFragment(plan, anchorNodeId, fragment)
    const problem = workPlanProblems(proposed, ctx).find((p) => p.severity === 'block')
    return problem ? { ok: false, reason: problem.message } : { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
