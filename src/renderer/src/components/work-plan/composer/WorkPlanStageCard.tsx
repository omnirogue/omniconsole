import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { actorKey, actorLabel, composerActors } from './work-plan-composer-actors'
import {
  addCritiques,
  addJudge,
  addSynthesize,
  critiquesOf,
  judgeOf,
  setReadsWinnerOf,
  synthesisOf,
  toggleVerifyDoneWhen
} from './work-plan-composer-convergence'
import {
  addStageAfter,
  duplicateStage,
  moveStage,
  removeStage,
  setReviewLoop,
  setSeatActor,
  setStageCount,
  setStageInstruction,
  setStageRole
} from './work-plan-composer-edits'
import {
  winnerSources,
  type ComposerStage,
  type ComposerStageNode
} from './work-plan-composer-stages'
import { SESSION_ACTION_PRESET_LABELS } from '../../../../../shared/session-action-presets'
import { workPlanNodeInstruction } from '../../../../../shared/work-plan-instruction'
import {
  WORK_PLAN_REVIEW_STOP_RULES,
  WORK_PLAN_ROLES,
  WORK_PLAN_ROLE_PRESET,
  workPlanNodeActors,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanProblem,
  type WorkPlanReviewStop,
  type WorkPlanRole
} from '../../../../../shared/work-plan-types'

export type WorkPlanStageCardProps = {
  plan: WorkPlan
  ctx: WorkPlanContext
  stage: ComposerStage
  stageCount: number
  problems: readonly WorkPlanProblem[]
  onChange: (plan: WorkPlan) => void
}

export function stageRoleOf(node: ComposerStageNode): WorkPlanRole {
  return node.kind === 'review' ? 'review' : node.role
}

export function stageRoleLabel(node: ComposerStageNode): string {
  return SESSION_ACTION_PRESET_LABELS[WORK_PLAN_ROLE_PRESET[stageRoleOf(node)]]
}

/**
 * One TRANSFORM stage, as the five knobs it actually is: ACTION (what), ACTOR (who), TOPOLOGY
 * (how many, how many rounds), CONVERGENCE (how many results become one) and ROUTE (where the
 * result goes). They are knobs of one stage, never peers of the Outcome above the chain.
 */
export function WorkPlanStageCard({
  plan,
  ctx,
  stage,
  stageCount,
  problems,
  onChange
}: WorkPlanStageCardProps) {
  const node = stage.nodes[0]!
  const role = stageRoleOf(node)
  // One descriptor per seat, so the actor picker edits exactly the seat it is drawn beside even
  // when the stage is a group of sibling nodes rather than one ×N node.
  const seats = stage.nodes.flatMap((entry) =>
    workPlanNodeActors(entry).map((actor, index) => ({ nodeId: entry.id, index, actor }))
  )
  const actors = composerActors(ctx)
  const prefilled = workPlanNodeInstruction(plan, node)
  const parallel = stage.seats > 1
  const single = stage.nodes.length === 1
  const winners = winnerSources(plan, stage)
  const winner = winners.at(-1)
  const verdict = node.kind === 'worker' && node.role === 'verify' ? node.verdict : undefined
  return (
    <li
      aria-label={translate('workPlan.stage', 'Stage {{index}}', { index: stage.index })}
      className="space-y-2 rounded-md border p-2 text-xs"
      data-node-id={stage.key}
      data-stage-role={role}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {parallel
            ? translate(
                'workPlan.stageHeadingParallel',
                'Stage {{index}} · {{action}} ×{{seats}}',
                {
                  index: stage.index,
                  action: stageRoleLabel(node),
                  seats: stage.seats
                }
              )
            : translate('workPlan.stageHeading', 'Stage {{index}} · {{action}}', {
                index: stage.index,
                action: stageRoleLabel(node)
              })}
        </span>
        <span className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={stage.index === 1}
            onClick={() => onChange(moveStage(plan, stage, -1, ctx))}
          >
            {translate('workPlan.moveUp', 'Move up')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={stage.index === stageCount}
            onClick={() => onChange(moveStage(plan, stage, 1, ctx))}
          >
            {translate('workPlan.moveDown', 'Move down')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onChange(duplicateStage(plan, stage, ctx))}
          >
            {translate('workPlan.duplicateStage', 'Duplicate stage')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onChange(removeStage(plan, stage, ctx))}
          >
            {translate('workPlan.removeStage', 'Remove stage')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => onChange(addStageAfter(plan, stage, ctx))}
          >
            {translate('workPlan.addStageAfter', 'Add stage after')}
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={role}
          onValueChange={(next) => onChange(setStageRole(plan, stage, next as WorkPlanRole, ctx))}
        >
          <SelectTrigger aria-label={translate('workPlan.action', 'Action')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORK_PLAN_ROLES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {SESSION_ACTION_PRESET_LABELS[WORK_PLAN_ROLE_PRESET[entry]]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {single && (
          <label className="flex items-center gap-1">
            {translate('workPlan.seats', 'Seats')}
            <Input
              aria-label={translate('workPlan.seats', 'Seats')}
              className="w-16"
              type="number"
              min={1}
              value={seats.length}
              onChange={(event) =>
                onChange(setStageCount(plan, stage, Number(event.target.value), ctx))
              }
            />
          </label>
        )}
        {node.kind === 'review' && (
          <>
            <label className="flex items-center gap-1">
              {translate('workPlan.rounds', 'Rounds')}
              <Input
                aria-label={translate('workPlan.rounds', 'Rounds')}
                className="w-16"
                type="number"
                min={1}
                value={node.maxRounds}
                onChange={(event) =>
                  onChange(setReviewLoop(plan, node.id, { maxRounds: Number(event.target.value) }))
                }
              />
            </label>
            <Select
              value={node.stop}
              onValueChange={(next) =>
                onChange(setReviewLoop(plan, node.id, { stop: next as WorkPlanReviewStop }))
              }
            >
              <SelectTrigger aria-label={translate('workPlan.stopRule', 'Stop rule')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORK_PLAN_REVIEW_STOP_RULES.map((stop) => (
                  <SelectItem key={stop} value={stop}>
                    {stop}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {seats.map(({ nodeId, index, actor }, seat) => (
          <Select
            key={`${nodeId}-seat-${index}`}
            value={actorKey(actor)}
            onValueChange={(next) =>
              onChange(
                setSeatActor(
                  plan,
                  nodeId,
                  index,
                  actors.find((entry) => actorKey(entry) === next) ?? actor,
                  ctx
                )
              )
            }
          >
            <SelectTrigger
              aria-label={translate('workPlan.actorSeat', 'Actor seat {{seat}}', {
                seat: seat + 1
              })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actors.map((entry) => (
                <SelectItem key={actorKey(entry)} value={actorKey(entry)}>
                  {actorLabel(entry)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))}
      </div>
      <Textarea
        aria-label={translate('workPlan.instruction', 'Instruction')}
        rows={2}
        value={node.instruction ? node.instruction : prefilled}
        onChange={(event) =>
          onChange(setStageInstruction(plan, stage, event.target.value, prefilled))
        }
      />
      {parallel && (
        <div
          aria-label={translate('workPlan.convergence', 'Convergence')}
          className="flex flex-wrap gap-1"
        >
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={Boolean(synthesisOf(plan, stage))}
            onClick={() => onChange(addSynthesize(plan, stage, ctx))}
          >
            {translate('workPlan.synthesize', 'Synthesize')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={Boolean(judgeOf(plan, stage))}
            onClick={() => onChange(addJudge(plan, stage, ctx))}
          >
            {translate('workPlan.judge', 'Judge')}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={critiquesOf(plan, stage).length > 0}
            onClick={() => onChange(addCritiques(plan, stage, ctx))}
          >
            {translate('workPlan.critiqueEachOther', 'Critique each other')}
          </Button>
        </div>
      )}
      {winner && single && node.kind === 'worker' && (
        <label className="flex items-center gap-2">
          <Checkbox
            aria-label={translate('workPlan.runOnWinner', 'Run on the winner')}
            checked={node.readsWinnerOf === winner.id}
            onCheckedChange={(checked) =>
              onChange(setReadsWinnerOf(plan, stage, checked === true ? winner.id : null, ctx))
            }
          />
          {translate('workPlan.runOnWinnerOf', 'Run on the winner of {{action}}', {
            action: stageRoleLabel(winner)
          })}
        </label>
      )}
      {verdict && (
        <fieldset
          aria-label={translate('workPlan.doneWhenChecked', 'Done When checked here')}
          className="space-y-1"
        >
          {plan.outcome.doneWhen.map((entry) => (
            <label className="flex items-center gap-2" key={entry.id}>
              <Checkbox
                aria-label={translate('workPlan.doneWhenEntry', 'Done When: {{text}}', {
                  text: entry.text
                })}
                checked={verdict.over.includes(entry.id)}
                onCheckedChange={() => onChange(toggleVerifyDoneWhen(plan, node.id, entry.id))}
              />
              {entry.text}
            </label>
          ))}
        </fieldset>
      )}
      <p aria-label={translate('workPlan.route', 'Route')} className="text-muted-foreground">
        {translate('workPlan.routeNewAgent', 'New agent · given the whole conversation')}
      </p>
      {problems.map((problem) => (
        <p className="text-destructive" key={`${problem.code}-${problem.nodeId}`} role="alert">
          {problem.message}
        </p>
      ))}
    </li>
  )
}
