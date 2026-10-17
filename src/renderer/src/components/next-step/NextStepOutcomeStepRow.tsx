import { useState } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { NextStepOutcomeStep } from '../../../../shared/next-step-draft'
import { HandoffFields } from './NextStepOutcomeHandoffFields'
import { NextStepOutcomeReviewFields } from './NextStepOutcomeReviewFields'
import {
  describeReviewer,
  handoffWithPreset,
  type NextStepHandoffStep
} from './next-step-outcome-sections'
import { actionLabel, nextStepAgentName } from './next-step-summary'
import { useHoverOpenPopover } from './use-hover-open-popover'

/** "Claude opus high, Codex · 3 rounds · Adversarial" / "Codex · 🛠 Implement". */
export function outcomeStepSummary(step: NextStepOutcomeStep): string {
  if (step.kind === 'review') {
    return [
      step.reviewers.length
        ? step.reviewers.map((actor) => describeReviewer(actor, nextStepAgentName)).join(', ')
        : translate('nextStep.noReviewersYet', 'No reviewers yet'),
      step.maxRounds === 1
        ? translate('nextStep.oneRound', '1 round')
        : translate('nextStep.roundsCount', '{{count}} rounds', { count: step.maxRounds }),
      step.adversarial ? translate('nextStep.adversarial', 'Adversarial') : '',
      step.repairWithSource && step.maxRounds > 1
        ? translate('nextStep.sourceRepairs', 'Original builder repairs')
        : ''
    ]
      .filter(Boolean)
      .join(' · ')
  }
  const actor = step.actor
    ? `${nextStepAgentName(step.actor.agent)} · ${actionLabel(step.presetId)}`
    : translate('nextStep.chooseResponsibleAgent', 'Choose the responsible agent.')
  return step.reviewRepair
    ? `${actor} · ${translate('nextStep.onlyReviewFindings', 'Only on review findings')}`
    : actor
}

/**
 * One step of the plan as one line — "1 · Review · Claude opus high · 3 rounds". Hovering or
 * clicking the line opens its editor in a popover; the reorder and remove controls sit at the
 * end of the line and show on hover.
 */
export function NextStepOutcomeStepRow({
  step,
  previousStep,
  followingStep,
  index,
  total,
  agents,
  worktreeSelector,
  onChange,
  onMove,
  onRemove
}: {
  step: NextStepOutcomeStep
  previousStep?: NextStepOutcomeStep
  followingStep?: NextStepOutcomeStep
  index: number
  total: number
  agents: AgentCatalogEntry[]
  worktreeSelector: string | null
  onChange: (step: NextStepOutcomeStep) => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  const number = index + 1
  const hasRepairAgent = followingStep?.kind === 'handoff' && followingStep.reviewRepair
  const summary = outcomeStepSummary(
    step.kind === 'review' && hasRepairAgent ? { ...step, repairWithSource: false } : step
  )
  const kind =
    step.kind === 'review'
      ? translate('nextStep.addReview', 'Review')
      : translate('nextStep.addOneAgent', 'Agent')
  return (
    <div className="group flex items-center gap-0.5" data-next-step-outcome-step={step.kind}>
      <Popover open={open} onOpenChange={hover.onOpenChange}>
        <PopoverAnchor asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-haspopup="dialog"
            aria-expanded={open}
            title={summary}
            {...hover.anchorProps}
          >
            <span className="shrink-0 text-muted-foreground">{`${number} · `}</span>
            <span className="shrink-0 font-medium">{kind}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{` · ${summary}`}</span>
          </button>
        </PopoverAnchor>
        <PopoverContent
          side="bottom"
          align="start"
          className="popover-wheel-scroll max-h-[min(520px,calc(100vh-2rem))] w-[min(520px,calc(100vw-1rem))] space-y-2 overflow-y-auto p-3 scrollbar-sleek"
          aria-label={translate('nextStep.stepEditor', 'Step {{number}} · {{kind}}', {
            number,
            kind
          })}
          {...hover.contentProps}
        >
          <p className="text-xs font-medium">
            {translate('nextStep.stepEditor', 'Step {{number}} · {{kind}}', { number, kind })}
          </p>
          {step.kind === 'review' ? (
            <NextStepOutcomeReviewFields
              step={step}
              previousStep={previousStep}
              agents={agents}
              hasRepairAgent={hasRepairAgent}
              worktreeSelector={worktreeSelector}
              onChange={onChange}
            />
          ) : (
            <>
              <HandoffFields
                step={step}
                reviewRounds={previousStep?.kind === 'review' ? previousStep.maxRounds : undefined}
                agents={agents}
                worktreeSelector={worktreeSelector}
                updateActor={(actor) => onChange({ ...step, actor })}
                onChange={(next) =>
                  onChange(
                    next.kind === 'handoff' && next.presetId !== step.presetId
                      ? handoffWithPreset(step, next.presetId)
                      : (next as NextStepHandoffStep)
                  )
                }
              />
              <Textarea
                rows={2}
                value={step.instructions}
                aria-label={translate(
                  'nextStep.agentInstructions',
                  'Instructions for agent {{number}}',
                  { number }
                )}
                onChange={(event) => onChange({ ...step, instructions: event.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                {step.reviewRepair
                  ? translate(
                      'nextStep.repairReceivesFindings',
                      'Repairs blocking findings between review rounds. Skipped when the review passes.'
                    )
                  : translate(
                      'nextStep.agentReceivesContext',
                      "Receives this session's files and context through Handoff, after the step above."
                    )}
              </p>
            </>
          )}
        </PopoverContent>
      </Popover>
      <span className="flex shrink-0 opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('nextStep.moveStepUp', 'Move step up')}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('nextStep.moveStepDown', 'Move step down')}
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown className="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate('nextStep.removeStep', 'Remove step')}
          onClick={onRemove}
        >
          <Trash2 className="size-3" />
        </Button>
      </span>
    </div>
  )
}
