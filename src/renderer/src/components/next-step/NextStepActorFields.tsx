import { FleetFallbackFields } from './FleetFallbackFields'
import {
  localFallbackChoices,
  localFallbackModels,
  localFallbackProblem
} from './local-fallback-selection'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { useId } from 'react'
import { translate } from '@/i18n/i18n'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { Button } from '@/components/ui/button'
import {
  BuildReviewModelEffortFields,
  CatalogModelEffortFields
} from '@/components/build-review/BuildReviewAgentFields'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type { NextStepActor } from '../../../../shared/next-step-draft'

export function ActorFields({
  actor,
  agents,
  worktreeSelector,
  onChange
}: {
  actor: NextStepActor
  agents: (AgentCatalogEntry & { models?: CatalogModel[] })[]
  worktreeSelector: string | null
  onChange: (actor: NextStepActor) => void
}): React.JSX.Element {
  const id = useId()
  const models = agents.find((entry) => entry.id === actor.agent)?.models ?? []
  const choices = actor.agent === 'omp' ? localFallbackChoices(models) : []
  const primary = actor.model?.startsWith('openrouter/')
    ? actor.model.slice('openrouter/'.length)
    : null
  return (
    <div className="space-y-2">
      <AgentCombobox
        agents={agents}
        value={actor.agent}
        allowBlankTerminal={false}
        allowNarrowTrigger
        triggerClassName="min-w-0 w-full"
        emptyLabel="Select an agent"
        onValueChange={(agent) => {
          if (agent) {
            onChange({ agent, openrouterCandidates: actor.openrouterCandidates })
          }
        }}
      />
      {worktreeSelector ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {translate('nextStep.modelAndEffort', 'Model and effort')}
          </summary>
          {actor.agent === 'omp' ? (
            <CatalogModelEffortFields
              role={`${id}-outcome-actor`}
              agent={actor.agent}
              models={localFallbackModels(models)}
              model={actor.model}
              effort={actor.effort}
              preserveUnavailable
              onChange={(next) => onChange({ ...actor, model: next.model, effort: next.effort })}
            />
          ) : (
            <BuildReviewModelEffortFields
              capabilityMode="task-continuation"
              role={`${id}-outcome-actor`}
              agent={actor.agent}
              worktree={worktreeSelector}
              model={actor.model}
              effort={actor.effort}
              onChange={(next) =>
                onChange({
                  ...actor,
                  model: next.model,
                  effort: next.effort
                })
              }
            />
          )}
          {actor.accountChoiceId ? (
            <div className="space-y-1 text-xs text-destructive">
              <p>
                {translate(
                  'nextStep.accountOverrideUnsupported',
                  'Scheduled outcomes use the current sign-in. Clear the saved account override to continue.'
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onChange({ ...actor, accountChoiceId: null })}
              >
                {translate('nextStep.useCurrentSignIn', 'Use current sign-in')}
              </Button>
            </div>
          ) : null}
        </details>
      ) : null}
      {actor.agent === 'omp' || actor.openrouterCandidates !== undefined ? (
        <FleetFallbackFields
          primary={primary}
          candidates={actor.openrouterCandidates}
          choices={choices}
          canEnable={choices.some((choice) => choice.id === primary)}
          problem={localFallbackProblem(actor, models)}
          onChange={(openrouterCandidates) => onChange({ ...actor, openrouterCandidates })}
        />
      ) : null}
    </div>
  )
}
