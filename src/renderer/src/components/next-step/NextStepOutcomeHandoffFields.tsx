import { translate } from '@/i18n/i18n'
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { NextStepActor, NextStepOutcomeStep } from '../../../../shared/next-step-draft'
import type { SessionActionPresetId } from '../../../../shared/session-action-presets'
import { ActorFields } from './NextStepActorFields'

const HANDOFF_ACTIONS: readonly SessionActionPresetId[] = [
  'implement',
  'improve',
  'research',
  'plan'
]

export function HandoffFields({
  step,
  reviewRounds,
  agents,
  worktreeSelector,
  updateActor,
  onChange
}: {
  step: Extract<NextStepOutcomeStep, { kind: 'handoff' }>
  reviewRounds?: number
  agents: AgentCatalogEntry[]
  worktreeSelector: string | null
  updateActor: (actor: NextStepActor) => void
  onChange: (step: NextStepOutcomeStep) => void
}): React.JSX.Element {
  return (
    <>
      {step.actor ? (
        <ActorFields
          actor={step.actor}
          agents={agents}
          worktreeSelector={worktreeSelector}
          onChange={updateActor}
        />
      ) : (
        <p className="text-xs text-destructive">
          {translate('nextStep.chooseResponsibleAgent', 'Choose the responsible agent.')}
        </p>
      )}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={step.presetId}
        onValueChange={(value) => {
          if (HANDOFF_ACTIONS.includes(value as SessionActionPresetId)) {
            onChange({ ...step, presetId: value as SessionActionPresetId })
          }
        }}
        aria-label={translate('nextStep.handoffAction', 'Handoff action')}
      >
        {HANDOFF_ACTIONS.map((action) => (
          <ToggleGroupItem key={action} value={action} className="h-7 px-2 text-xs">
            {action}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {reviewRounds !== undefined || step.reviewRepair ? (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={step.reviewRepair === true}
              disabled={!step.reviewRepair && (reviewRounds === undefined || reviewRounds < 2)}
              onCheckedChange={(checked) => onChange({ ...step, reviewRepair: checked === true })}
            />
            {translate(
              'nextStep.repairReviewFindings',
              'Repair blocking findings between review rounds'
            )}
          </label>
          {reviewRounds !== undefined && reviewRounds < 2 ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'nextStep.repairNeedsRounds',
                'Choose at least two review rounds to enable repair.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
