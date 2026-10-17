import { afterStepRecipient, recipientAfterStep } from './next-step-after-actor'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import { Plus, X } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { RecipientIdentityChoice } from './RecipientIdentityChoice'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import {
  defaultNextStepInstructions,
  NEXT_STEP_ROUND_PRESETS,
  type NextStepAfterStep,
  type NextStepDraft
} from '../../../../shared/next-step-draft'
import { NEXT_STEP_ACTION_ORDER, NEXT_STEP_SHAPE_GLYPH } from '../../../../shared/next-step-glyphs'
import type { SessionActionPresetId } from '../../../../shared/session-action-presets'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { NextStepAgentCard } from './NextStepAgentCard'
import { actionLabel } from './next-step-summary'
import type { NextStepAvailableAgent } from './use-next-step-recipients'

/**
 * "Then…": what happens once the agent(s) finish, as an ordered list that reads like
 * the strip it becomes — ✨ Improve → 👀 Review → 👤 Uma. Empty means nothing more; the
 * results stay in the workspace. Each entry feeds the next.
 */
export function NextStepAfterSteps({
  draft,
  agents,
  people,
  orgPeople,
  worktreeSelector,
  externalModels,
  localModels,
  fleetMachineId,
  parallel,
  problem = false,
  onChange
}: {
  draft: NextStepDraft
  agents: AgentCatalogEntry[]
  people: readonly TeamRosterPerson[]
  orgPeople?: readonly OrgChartPerson[]
  worktreeSelector: string
  externalModels?: NextStepAvailableAgent[]
  localModels?: NextStepAvailableAgent[]
  fleetMachineId?: string
  parallel: boolean
  /** Send to a person was chosen but nobody was picked yet. */
  problem?: boolean
  onChange: (after: NextStepAfterStep[]) => void
}): React.JSX.Element {
  const defaultAgent = agents[0]?.id ?? 'claude'
  // Why: a person's step completes when the work is delivered; later agents wait on the agents.
  const hasPeople = draft.recipients.some((recipient) => recipient.kind === 'person')
  const add = (presetId: SessionActionPresetId): void =>
    onChange([
      ...draft.after,
      {
        kind: 'agent',
        key: crypto.randomUUID(),
        actor: { agent: defaultAgent },
        presetId,
        instructions: defaultNextStepInstructions(presetId),
        rounds: 1
      }
    ])
  const addPerson = (): void =>
    onChange([...draft.after, { kind: 'person', key: crypto.randomUUID(), id: '', name: '' }])
  const replace = (key: string, next: NextStepAfterStep | null): void =>
    onChange(
      next
        ? draft.after.map((step) => (step.key === key ? next : step))
        : draft.after.filter((step) => step.key !== key)
    )
  return (
    <fieldset
      className="min-w-0 w-full space-y-2 rounded-md border border-border/60 p-3"
      data-next-step-after
    >
      <legend className="px-1 text-xs font-medium">
        {parallel
          ? hasPeople
            ? translate('nextStep.whenAgentsFinish', 'When the agents finish')
            : translate('nextStep.whenEveryoneFinishes', 'When everyone finishes')
          : translate('nextStep.whenItFinishes', 'When it finishes')}
      </legend>
      {draft.after.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('nextStep.afterNothing', 'Nothing more — the results stay in the workspace.')}
        </p>
      ) : null}
      {draft.after.map((step, index) => (
        <div key={step.key} className="flex items-start gap-1" data-next-step-after-step={index}>
          <span className="pt-2 text-xs text-muted-foreground">
            {NEXT_STEP_SHAPE_GLYPH.handoff}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            {step.kind === 'agent' ? (
              <>
                <AgentCombobox
                  agents={agents}
                  value={step.actor.agent}
                  // Why: a model, effort or account belongs to the agent it was chosen for.
                  onValueChange={(agent) =>
                    agent &&
                    replace(step.key, {
                      ...step,
                      actor: { agent, openrouterCandidates: step.actor.openrouterCandidates }
                    })
                  }
                  allowBlankTerminal={false}
                  allowNarrowTrigger
                  emptyLabel={translate(
                    'auto.components.SessionSidebar.selectAgent',
                    'Select an agent'
                  )}
                  triggerClassName="min-w-0 w-full"
                />
                <NextStepAgentCard
                  recipient={afterStepRecipient(step)}
                  fleetMachineId={fleetMachineId}
                  localModels={localModels?.find((entry) => entry.id === step.actor.agent)?.models}
                  worktreeSelector={worktreeSelector}
                  models={
                    externalModels
                      ? (externalModels.find((entry) => entry.id === step.actor.agent)?.models ??
                        [])
                      : undefined
                  }
                  roundsAllowed={NEXT_STEP_ROUND_PRESETS.includes(step.presetId)}
                  problem={false}
                  onChange={(next) => replace(step.key, recipientAfterStep(next, step))}
                />
              </>
            ) : (
              <div className="space-y-1 rounded-md border border-border/60 p-3">
                <p className="text-xs font-medium">
                  {NEXT_STEP_SHAPE_GLYPH.person}{' '}
                  {translate('nextStep.afterPerson', 'Send to a person')}
                </p>
                {problem && !step.id ? (
                  <p className="text-[11px] text-destructive">
                    {translate('nextStep.choosePerson', 'Choose who receives the result.')}
                  </p>
                ) : null}
                <RecipientIdentityChoice
                  allowAI
                  agents={agents}
                  onSelectAgent={(agent) =>
                    replace(step.key, {
                      kind: 'agent',
                      key: step.key,
                      actor: { agent: agent.id },
                      presetId: 'implement',
                      instructions: defaultNextStepInstructions('implement'),
                      rounds: 1
                    })
                  }
                  people={people}
                  orgPeople={orgPeople}
                  selected={
                    step.id
                      ? (people.find((person) => person.id === step.id) ?? {
                          id: step.id,
                          name: step.name
                        })
                      : null
                  }
                  onChange={(person) => {
                    replace(step.key, { ...step, id: person?.id ?? '', name: person?.name ?? '' })
                  }}
                />
              </div>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('nextStep.removeAfter', 'Remove this step')}
            onClick={() => replace(step.key, null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" data-next-step-then>
            <Plus className="size-3.5" />
            {translate('nextStep.then', 'Then…')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {NEXT_STEP_ACTION_ORDER.map((presetId) => (
            <DropdownMenuItem key={presetId} onSelect={() => add(presetId)}>
              {actionLabel(presetId)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={addPerson}>
            {NEXT_STEP_SHAPE_GLYPH.person} {translate('nextStep.afterPerson', 'Send to a person')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </fieldset>
  )
}
