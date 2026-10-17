import {
  localFallbackChoices,
  localFallbackModels,
  localFallbackProblem
} from './local-fallback-selection'
import { FleetFallbackFields } from './FleetFallbackFields'
import { fleetFallbackChoices, fleetFallbackProblem } from './fleet-fallback-selection'
import { useId } from 'react'
import { AgentAccountSelect } from '@/components/agent/AgentAccountSelect'
import {
  BuildReviewModelEffortFields,
  CatalogModelEffortFields
} from '@/components/build-review/BuildReviewAgentFields'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { RecipientAvatar } from './recipient-avatar'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import {
  defaultNextStepInstructions,
  NEXT_STEP_MAX_ROUNDS,
  type NextStepAgentRecipient
} from '../../../../shared/next-step-draft'
import { NEXT_STEP_ACTION_ORDER } from '../../../../shared/next-step-glyphs'
import { isSessionActionPresetId } from '../../../../shared/session-action-presets'
import { actionLabel, describeNextStepAgent, nextStepAgentName } from './next-step-summary'

/**
 * One chosen agent: what should it do (the existing actions), then model and effort,
 * rounds where the action repeats well, and the pre-filled instructions underneath.
 * Nothing here asks for a prompt from scratch.
 */
const NO_LOCAL_MODELS: CatalogModel[] = []

export function NextStepAgentCard({
  recipient,
  worktreeSelector,
  models,
  fleetMachineId,
  localModels = NO_LOCAL_MODELS,
  roundsAllowed,
  problem,
  onChange
}: {
  recipient: NextStepAgentRecipient
  /** Runtime workspace selector for model detection; null when no host is known (a card or thread). */
  worktreeSelector: string | null
  /** An external execution catalog avoids probing this computer for remote choices. */
  models?: CatalogModel[]
  fleetMachineId?: string
  localModels?: CatalogModel[]
  roundsAllowed: boolean
  /** The draft cannot send until this is answered. */
  problem: boolean
  onChange: (recipient: NextStepAgentRecipient) => void
}): React.JSX.Element {
  const id = useId()
  const fallbackChoices =
    recipient.agent === 'omp'
      ? models !== undefined
        ? fleetFallbackChoices(models, fleetMachineId)
        : localFallbackChoices(localModels)
      : []
  const modelCatalog =
    models ?? (recipient.agent === 'omp' ? localFallbackModels(localModels) : undefined)
  const primary = recipient.model?.startsWith('openrouter/')
    ? recipient.model.slice('openrouter/'.length)
    : null
  const choosePreset = (value: string): void => {
    if (!isSessionActionPresetId(value)) {
      return
    }
    // Why: the instructions follow the action until the person edits them.
    const untouched =
      !recipient.instructions.trim() ||
      (recipient.presetId !== null &&
        recipient.instructions === defaultNextStepInstructions(recipient.presetId))
    onChange({
      ...recipient,
      presetId: value,
      instructions: untouched ? defaultNextStepInstructions(value) : recipient.instructions
    })
  }
  return (
    <div
      className="min-w-0 w-full space-y-2 rounded-md border border-border/60 p-3"
      data-next-step-agent={recipient.agent}
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <RecipientAvatar agent />
        <span>{nextStepAgentName(recipient.agent)}</span>
        <span className="truncate text-muted-foreground">
          {recipient.presetId ? describeNextStepAgent(recipient, !roundsAllowed) : ''}
        </span>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">
          {translate('nextStep.whatShouldItDo', 'What should it do?')}
        </Label>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="min-w-0 w-full flex-wrap justify-start"
          value={recipient.presetId ?? ''}
          onValueChange={choosePreset}
          aria-label={translate('nextStep.whatShouldItDo', 'What should it do?')}
        >
          {NEXT_STEP_ACTION_ORDER.map((presetId) => (
            <ToggleGroupItem key={presetId} value={presetId} className="h-7 px-2 text-xs">
              {actionLabel(presetId)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {problem ? (
          <p className="text-[11px] text-destructive">
            {translate('nextStep.chooseAction', 'Choose what {{agent}} should do.', {
              agent: nextStepAgentName(recipient.agent)
            })}
          </p>
        ) : null}
      </div>
      {recipient.presetId || recipient.instructions.trim() ? (
        <>
          {modelCatalog !== undefined || worktreeSelector ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {translate('conversations.modelEffort', 'Model and effort')}
              </summary>
              {modelCatalog !== undefined ? (
                <CatalogModelEffortFields
                  role={`${id}-actor`}
                  agent={recipient.agent}
                  models={modelCatalog}
                  preserveUnavailable
                  model={recipient.model}
                  effort={recipient.effort}
                  onChange={(next) => onChange(withModelEffort(recipient, next))}
                />
              ) : worktreeSelector ? (
                <BuildReviewModelEffortFields
                  capabilityMode="task-continuation"
                  role={`${id}-actor`}
                  agent={recipient.agent}
                  worktree={worktreeSelector}
                  model={recipient.model}
                  effort={recipient.effort}
                  onChange={(next) => onChange(withModelEffort(recipient, next))}
                />
              ) : null}
            </details>
          ) : null}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {translate('nextStep.advanced', 'Advanced')}
            </summary>
            <div className="space-y-2 pt-2">
              {roundsAllowed ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor={`${id}-rounds`} className="text-xs">
                    {translate('nextStep.roundsLabel', 'Rounds')}
                  </Label>
                  <Select
                    value={String(recipient.rounds)}
                    onValueChange={(value) => onChange({ ...recipient, rounds: Number(value) })}
                  >
                    <SelectTrigger id={`${id}-rounds`} size="sm" className="h-7 w-20 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: NEXT_STEP_MAX_ROUNDS }, (_, index) => index + 1).map(
                        (count) => (
                          <SelectItem key={count} value={String(count)}>
                            {count}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <Textarea
                id={`${id}-instructions`}
                rows={3}
                value={recipient.instructions}
                aria-label={translate('nextStep.instructions', 'Instructions')}
                onChange={(event) => onChange({ ...recipient, instructions: event.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                {translate(
                  'nextStep.contextIncluded',
                  'The current work and its files are passed along automatically.'
                )}
              </p>
              {worktreeSelector && models === undefined ? (
                <AgentAccountSelect
                  verifiedChoiceIds={[]}
                  id={`${id}-account`}
                  agent={recipient.agent}
                  value={recipient.accountChoiceId ?? null}
                  onChange={(accountChoiceId) => onChange({ ...recipient, accountChoiceId })}
                />
              ) : null}
            </div>
          </details>
        </>
      ) : null}
      {recipient.agent === 'omp' || recipient.openrouterCandidates !== undefined ? (
        <FleetFallbackFields
          primary={primary}
          candidates={recipient.openrouterCandidates}
          choices={fallbackChoices}
          canEnable={fallbackChoices.some((choice) => choice.id === primary)}
          problem={
            models !== undefined
              ? fleetFallbackProblem(recipient, models, fleetMachineId)
              : localFallbackProblem(recipient, localModels)
          }
          onChange={(openrouterCandidates) => onChange({ ...recipient, openrouterCandidates })}
        />
      ) : null}
    </div>
  )
}

/** A cleared model or effort is cleared, not kept from before. */
function withModelEffort(
  recipient: NextStepAgentRecipient,
  next: { model?: string; effort?: string }
): NextStepAgentRecipient {
  const { model: _model, effort: _effort, ...rest } = recipient
  return {
    ...rest,
    ...(next.model ? { model: next.model } : {}),
    ...(next.effort ? { effort: next.effort } : {})
  }
}
