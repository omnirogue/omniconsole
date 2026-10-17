import {
  isIndependentLineage,
  mayIssueVerdict,
  modelLineage
} from '../../../../../shared/model-lineage'
import { workPlanShapeActors } from '../../../../../shared/work-plan-shapes'
import type { WorkPlanActor, WorkPlanContext } from '../../../../../shared/work-plan-types'

/**
 * Who this host can seat, in the order the shapes already assign from: one seat per model family
 * first, then the repeats. The dialog assigns from the SAME order as `workPlanFromShape`, so a
 * chain drawn by hand and a chain drawn by a shape seat their agents identically.
 */
export function composerActors(ctx: WorkPlanContext): WorkPlanActor[] {
  return workPlanShapeActors(ctx)
}

export function actorKey(actor: WorkPlanActor): string {
  return `${actor.agent}:${actor.model ?? ''}:${actor.effort ?? ''}`
}

export function actorLabel(actor: WorkPlanActor): string {
  return [actor.agent, actor.model, actor.effort].filter(Boolean).join(' · ')
}

export function actorFromKey(ctx: WorkPlanContext, key: string): WorkPlanActor | undefined {
  return composerActors(ctx).find((actor) => actorKey(actor) === key)
}

/**
 * One actor per seat: distinct while the host has distinct families, then cycled. A cycled seat
 * stays IN the plan so the validator can say those two seats are not a second opinion — dropping
 * it would let ×N claim an independence the host cannot give.
 */
export function assignSeats(
  ctx: WorkPlanContext,
  count: number,
  fallback: WorkPlanActor,
  eligible?: (actor: WorkPlanActor) => boolean
): WorkPlanActor[] {
  const actors = composerActors(ctx).filter((actor) => !eligible || eligible(actor))
  const pool = actors.length ? actors : [fallback]
  return Array.from(
    { length: Math.max(1, Math.trunc(count)) },
    (_, seat) => pool[seat % pool.length]!
  )
}

/**
 * A judge comes from a family none of the candidates belong to. When this host has no such
 * agent the plan still gets a judge, because the validator's sentence ("you have N usable
 * agents") is the honest answer — a silently missing judge would read as a plan that works.
 */
export function judgeActor(
  ctx: WorkPlanContext,
  candidates: readonly WorkPlanActor[],
  fallback: WorkPlanActor
): WorkPlanActor {
  const pool = composerActors(ctx)
  const families = [...new Set(candidates.map((actor) => modelLineage(actor.agent, actor.model)))]
  const independent = pool.find(
    (actor) =>
      mayIssueVerdict(actor.agent, actor.model) &&
      families.every((family) =>
        isIndependentLineage(family, modelLineage(actor.agent, actor.model))
      )
  )
  return (
    independent ??
    pool.find((actor) => mayIssueVerdict(actor.agent, actor.model)) ??
    pool[0] ??
    fallback
  )
}
