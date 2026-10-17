import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { WorkPlanComposerSummary } from './WorkPlanComposerSummary'
import { WorkPlanStageCard } from './WorkPlanStageCard'
import { addStageAfter, setFinishHow } from './work-plan-composer-edits'
import { normalizeComposerPlan } from './work-plan-composer-graph'
import {
  composerBlocks,
  composerFinish,
  composerStages,
  planWideProblems,
  stageProblems,
  workPlanComposerProblems
} from './work-plan-composer-stages'
import type {
  WorkPlan,
  WorkPlanContext,
  WorkPlanFinishNode
} from '../../../../../shared/work-plan-types'

export type WorkPlanComposerDialogProps = {
  open: boolean
  /** The plan the bar is showing; the dialog edits its own copy until `Use this chain`. */
  plan: WorkPlan
  ctx: WorkPlanContext
  capacity: number
  onUse: (plan: WorkPlan) => void
  onCancel: () => void
  useError?: string
  useDisabled?: boolean
}

/** Read per render, never at module load, so a language change is not frozen into a constant. */
function finishLabel(how: WorkPlanFinishNode['how']): string {
  return how === 'my-review'
    ? translate('workPlan.finishMine', 'Me · I decide')
    : translate('workPlan.finishComplete', 'Complete on its own')
}

/**
 * The visual composer. It edits the SAME WorkPlan object the bar sends: one ordered list of
 * stages above one Outcome, with the chain, the counts and the sentence derived from that object
 * on every edit. Nothing here authors runtime state — there is no wait, no snooze and no
 * "running" to set, because waits, attempts and receipts are things the host observes, not
 * things a person draws.
 */
export function WorkPlanComposerDialog({
  open,
  plan,
  ctx,
  capacity,
  onUse,
  onCancel,
  useError,
  useDisabled = false
}: WorkPlanComposerDialogProps) {
  const [draft, setDraft] = useState<WorkPlan>(() => normalizeComposerPlan(plan, ctx))
  const problems = workPlanComposerProblems(draft, ctx)
  const blocks = composerBlocks(problems)
  const stages = composerStages(draft)
  const finish = composerFinish(draft)
  const first = blocks[0]
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        aria-label={translate('workPlan.customChain', 'Custom chain')}
        className="max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>{translate('workPlan.customChain', 'Custom chain')}</DialogTitle>
          <DialogDescription>{draft.outcome.title}</DialogDescription>
        </DialogHeader>
        <WorkPlanComposerSummary
          plan={draft}
          capacity={capacity}
          stageCount={stages.length}
          runnable={blocks.length === 0}
        />
        <ul className="space-y-2">
          {stages.map((stage) => (
            <WorkPlanStageCard
              ctx={ctx}
              key={stage.key}
              onChange={setDraft}
              plan={draft}
              problems={stageProblems(problems, stage)}
              stage={stage}
              stageCount={stages.length}
            />
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setDraft(addStageAfter(draft, undefined, ctx))}
          >
            {translate('workPlan.addStage', 'Add stage')}
          </Button>
          {finish && (
            <label className="flex items-center gap-2">
              {translate('workPlan.finish', 'Finish')}
              <Select
                value={finish.how}
                onValueChange={(next) =>
                  setDraft(setFinishHow(draft, next as WorkPlanFinishNode['how'], ctx))
                }
              >
                <SelectTrigger aria-label={translate('workPlan.finish', 'Finish')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="my-review">{finishLabel('my-review')}</SelectItem>
                  <SelectItem value="complete">{finishLabel('complete')}</SelectItem>
                </SelectContent>
              </Select>
              <span aria-label={translate('workPlan.finishRoute', 'Finish route')}>
                {finish.how === 'my-review'
                  ? translate('workPlan.finishRouteMe', '👤 Me')
                  : translate('workPlan.finishRouteDone', '✓ Done')}
              </span>
            </label>
          )}
        </div>
        {planWideProblems(draft, problems).map((problem) => (
          <p className="text-xs text-destructive" key={problem.code} role="alert">
            {problem.message}
          </p>
        ))}
        {useError && (
          <p role="alert" className="text-xs text-destructive">
            {useError}
          </p>
        )}
        <DialogFooter>
          {first && <span className="text-xs text-destructive">{first.message}</span>}
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {translate('workPlan.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={useDisabled || blocks.length > 0}
            onClick={() => onUse(draft)}
          >
            {translate('workPlan.useThisChain', 'Use this chain')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
