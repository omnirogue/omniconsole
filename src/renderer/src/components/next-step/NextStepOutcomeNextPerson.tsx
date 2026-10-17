import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import type {
  NextStepHandoffOptions,
  NextStepOutcomeDraft
} from '../../../../shared/next-step-draft'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { NextStepOutcomePackageLine } from './NextStepOutcomePackage'
import { NextStepOutcomeSection } from './NextStepOutcomeSection'
import { NextStepTeamPicker } from './NextStepTeamPicker'
import type { NextStepOutcomeFacts } from './next-step-outcome-facts'
import type { SessionChangedFilesState } from './next-step-session-changes'
import {
  finishForNextPerson,
  finishWithTeammateMode,
  nextPersonChoice,
  teammateMode,
  type NextStepPersonFinish
} from './next-step-outcome-sections'
import { outcomeFinishLabel } from './next-step-summary'
import { RecipientAvatar, recipientPhoto } from './recipient-avatar'
import type { NextStepRecipientSource } from './use-next-step-recipients'
import { useHoverOpenPopover } from './use-hover-open-popover'

/** What travels with the work; present only when the dialog knows the session's facts. */
export type NextStepPackageProps = {
  facts: NextStepOutcomeFacts
  handoff: NextStepHandoffOptions
  onHandoffChange: (patch: Partial<NextStepHandoffOptions>) => void
  historyAvailable: boolean
  /** The files this session's workspace changed, detected for the package; refreshable. */
  autoFiles?: SessionChangedFilesState
}

/**
 * Section 4 — who receives the work once the agents are through: me, or one teammate.
 * Hovering Team shows the teammates; one click on a person chooses them, and only then do
 * Review | Hand off and the Package appear beneath.
 */
export function NextStepOutcomeNextPerson({
  outcome,
  people,
  orgPeople,
  recipientSource,
  timing,
  onTimingChange,
  onChange,
  pack
}: {
  outcome: NextStepOutcomeDraft
  people: readonly TeamRosterPerson[]
  orgPeople?: readonly OrgChartPerson[]
  recipientSource?: Pick<NextStepRecipientSource, 'people' | 'reload'>
  /** Present only while a Team handoff could go out before any agent runs. */
  timing?: 'now' | 'done'
  onTimingChange?: (timing: 'now' | 'done') => void
  onChange: (outcome: NextStepOutcomeDraft) => void
  pack?: NextStepPackageProps
}): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const hover = useHoverOpenPopover({ open: pickerOpen, onOpenChange: setPickerOpen })
  const choice = nextPersonChoice(outcome.finish)
  const person = outcome.finish?.kind === 'person' ? outcome.finish : null
  const github = outcome.finish?.kind === 'github' ? outcome.finish : null
  const chosen = person && !person.agentRecipient && person.personId ? person : null
  const selected = chosen
    ? (people.find((entry) => entry.id === chosen.personId) ?? {
        id: chosen.personId,
        name: chosen.personName
      })
    : null
  // Why: a pick from the hover-opened list is the whole choice; Team need not be clicked first.
  const base: NextStepPersonFinish = person ?? (finishForNextPerson('team') as NextStepPersonFinish)
  const openPicker = (): void => {
    hover.pin()
    setPickerOpen(true)
  }
  const selectPerson = (recipient: TeamRosterPerson): void => {
    onChange({
      ...outcome,
      finish: {
        ...base,
        personId: recipient.id,
        personName: recipient.name,
        agentRecipient: undefined
      }
    })
    hover.onOpenChange(false)
  }
  const chip = (label: string, avatar: React.ReactNode): React.JSX.Element => (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border py-0.5 pr-2 pl-0.5 text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
      aria-haspopup="dialog"
      aria-expanded={pickerOpen}
      data-selected-recipient={person?.personId}
      {...hover.anchorProps}
      onClick={openPicker}
    >
      {avatar}
      <span className="truncate">{label}</span>
      <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  )
  const modeHint = chosen
    ? teammateMode(chosen) === 'review'
      ? translate(
          'nextStep.teammateReviewHint',
          'Review — it comes back to you with their feedback.'
        )
      : translate('nextStep.teammateHandOffHint', 'Hand off — they own it from here.')
    : null
  return (
    <NextStepOutcomeSection
      id="finish"
      title={translate('nextStep.nextPerson', 'Next Person')}
      value={
        choice === 'me'
          ? translate('nextStep.me', 'Me')
          : person && !person.personId
            ? translate('nextStep.chooseTeammate', 'Choose a teammate')
            : (person?.personName ?? outcomeFinishLabel(outcome.finish))
      }
      hint={
        choice === 'me'
          ? translate('nextStep.nextPersonMeHint', 'Me — it comes back to you.')
          : person?.personId
            ? [outcomeFinishLabel(outcome.finish), modeHint].filter(Boolean).join(' · ')
            : translate('nextStep.pickTeammateHint', 'Hover Team and click a person.')
      }
      action={
        github ? null : (
          <Popover open={pickerOpen} onOpenChange={hover.onOpenChange}>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={choice}
              onValueChange={(value) => {
                if (value === 'me') {
                  hover.onOpenChange(false)
                  onChange({ ...outcome, finish: finishForNextPerson('me') })
                } else if (value === 'team') {
                  onChange({ ...outcome, finish: finishForNextPerson('team') })
                }
              }}
              aria-label={translate('nextStep.nextPerson', 'Next Person')}
            >
              <ToggleGroupItem value="me" className="h-7 px-2 text-xs">
                {translate('nextStep.me', 'Me')}
              </ToggleGroupItem>
              <PopoverAnchor asChild>
                <ToggleGroupItem
                  value="team"
                  className="h-7 px-2 text-xs"
                  aria-haspopup="dialog"
                  aria-expanded={pickerOpen}
                  {...hover.anchorProps}
                  onClick={openPicker}
                  onKeyDown={(event) => {
                    hover.anchorProps.onKeyDown(event)
                    // Why: the opening key also answers Team; the toggle's own click is suppressed.
                    if (event.defaultPrevented && choice !== 'team') {
                      onChange({ ...outcome, finish: finishForNextPerson('team') })
                    }
                  }}
                >
                  {translate('nextStep.team', 'Team')}
                </ToggleGroupItem>
              </PopoverAnchor>
            </ToggleGroup>
            <PopoverContent
              side="bottom"
              align="end"
              className="w-[min(360px,calc(100vw-1rem))] p-2"
              aria-label={translate('nextStep.chooseTeammate', 'Choose a teammate')}
              {...hover.contentProps}
            >
              <NextStepTeamPicker
                people={recipientSource?.people ?? { phase: 'ready', value: [...people] }}
                orgPeople={orgPeople}
                selectedId={chosen?.personId ?? null}
                onSelect={selectPerson}
                onRetry={recipientSource?.reload ?? (() => {})}
                agentRecipient={person?.agentRecipient}
                onAgentRecipient={(agentRecipient) => {
                  onChange({
                    ...outcome,
                    finish: {
                      ...base,
                      agentRecipient,
                      personId: agentRecipient.employeeId,
                      personName: agentRecipient.name,
                      action: 'fyi',
                      disposition: 'ownership'
                    }
                  })
                  hover.onOpenChange(false)
                }}
              />
            </PopoverContent>
          </Popover>
        )
      }
    >
      {github ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-2 text-xs">
          <span className="min-w-0 truncate">
            {translate(
              'nextStep.githubFinishNotice',
              'GitHub finish: {{action}} (set in an earlier version)',
              { action: outcomeFinishLabel(github) }
            )}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => onChange({ ...outcome, finish: finishForNextPerson('me') })}
          >
            {translate('nextStep.switchToMe', 'Switch to Me')}
          </Button>
        </div>
      ) : null}
      {person?.agentRecipient ? chip(person.agentRecipient.name, <RecipientAvatar agent />) : null}
      {chosen && selected ? (
        <div className="flex flex-wrap items-center gap-2">
          {chip(
            selected.name,
            <RecipientAvatar
              name={selected.name}
              photoUrl={recipientPhoto(selected, orgPeople ?? [])}
            />
          )}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={teammateMode(chosen)}
            onValueChange={(value) => {
              if (value === 'review' || value === 'handoff') {
                onChange({ ...outcome, finish: finishWithTeammateMode(chosen, value) })
              }
            }}
            aria-label={translate('nextStep.teammateMode', 'What the teammate does')}
          >
            <ToggleGroupItem value="review" className="h-6 px-2 text-[11px]">
              {translate('nextStep.teammateReview', 'Review')}
            </ToggleGroupItem>
            <ToggleGroupItem value="handoff" className="h-6 px-2 text-[11px]">
              {translate('nextStep.teammateHandOff', 'Hand off')}
            </ToggleGroupItem>
          </ToggleGroup>
          {timing && onTimingChange && outcome.steps.length === 0 ? (
            <div
              className="flex rounded-md border border-border p-0.5"
              role="group"
              aria-label={translate('nextStep.handoffTiming', 'Handoff timing')}
            >
              <Button
                type="button"
                size="xs"
                className="h-6 px-2 text-[11px]"
                variant={timing === 'now' ? 'secondary' : 'ghost'}
                aria-pressed={timing === 'now'}
                onClick={() => onTimingChange('now')}
              >
                {translate('nextStep.sendNow', 'Send now')}
              </Button>
              <Button
                type="button"
                size="xs"
                className="h-6 px-2 text-[11px]"
                variant={timing === 'done' ? 'secondary' : 'ghost'}
                aria-pressed={timing === 'done'}
                onClick={() => onTimingChange('done')}
              >
                {translate('nextStep.afterWorkAbove', 'After the work above')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {pack && person?.personId ? (
        // Why: the package only matters once someone receives the work.
        <NextStepOutcomePackageLine
          facts={pack.facts}
          handoff={pack.handoff}
          onHandoffChange={pack.onHandoffChange}
          timing={timing}
          historyAvailable={pack.historyAvailable}
          autoFiles={pack.autoFiles}
          teamRecipient
        />
      ) : null}
    </NextStepOutcomeSection>
  )
}
