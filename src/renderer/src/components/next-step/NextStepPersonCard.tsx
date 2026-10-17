import { useId } from 'react'
import { RecipientAvatar } from './recipient-avatar'
import { WorkflowTextField } from '@/components/console-workflows/WorkflowFields'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { CommunicationTypeSelect } from './CommunicationTypeSelect'
import { translate } from '@/i18n/i18n'
import type { NextStepDraft, NextStepPersonRecipient } from '../../../../shared/next-step-draft'
import type { SessionFollowUpDeliverables } from '../../../../shared/session-follow-up-rule'
import { NextStepWorkFiles, type NextStepTranscriptOption } from './NextStepWorkFiles'

/** Shared person fields for deferred handoffs and replies to an existing discussion. */
export function NextStepPeopleCard({
  people,
  photoFor,
  draft,
  included,
  taskTitle,
  cardless = false,
  workFiles,
  transcript,
  hideTaskContext = false,
  messageOnly = false,
  disabled = false,
  onChange
}: {
  people: NextStepPersonRecipient[]
  photoFor?: (person: NextStepPersonRecipient) => string | undefined
  draft: NextStepDraft
  /** One line on what the people receive, e.g. "Current work and files included". */
  included: string
  /** The card the handoff lands on; null when Send creates one, or none is needed. */
  taskTitle: string | null
  /** Card-less handoffs are on: without a card the request stands on its own. */
  cardless?: boolean
  workFiles?: {
    worktreeId: string
    workspacePath: string
    defaults: SessionFollowUpDeliverables | null
  }
  /** Size, message count and any redactor refusal for the session's transcript. */
  transcript?: Pick<NextStepTranscriptOption, 'preview' | 'error' | 'pending'>
  hideTaskContext?: boolean
  messageOnly?: boolean
  disabled?: boolean
  onChange: (patch: Partial<Pick<NextStepDraft, 'note' | 'handoff'>>) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3" data-next-step-people>
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
        {people.map((person) => (
          <span key={person.key} className="inline-flex min-w-0 items-center gap-2">
            <RecipientAvatar name={person.name} photoUrl={photoFor?.(person)} />
            <span className="truncate">{person.name}</span>
          </span>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">{included}</p>
      {!messageOnly && (
        <CommunicationTypeSelect
          value={draft.handoff.communicationType}
          disabled={disabled}
          onChange={(communicationType) =>
            onChange({ handoff: { ...draft.handoff, communicationType } })
          }
        />
      )}
      <Input
        id={`${id}-note`}
        value={draft.note}
        disabled={disabled}
        placeholder={translate('nextStep.notePlaceholder', 'Add a note… (optional)')}
        aria-label={translate('nextStep.note', 'Note')}
        onChange={(event) => onChange({ note: event.target.value })}
      />
      {!messageOnly && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-summary`}
            checked={draft.handoff.includeSummary}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({ handoff: { ...draft.handoff, includeSummary: checked === true } })
            }
          />
          <label htmlFor={`${id}-summary`} className="text-xs">
            {translate('nextStep.includeFinalSummary', 'Include final summary')}
          </label>
        </div>
      )}
      {!hideTaskContext ? (
        <p className="text-[11px] text-muted-foreground" data-next-step-lands-on>
          {taskTitle
            ? translate('nextStep.landsOnTask', 'Lands on the task “{{title}}”.', {
                title: taskTitle
              })
            : cardless
              ? translate(
                  'nextStep.standsAlone',
                  'Sent as a request on its own; no task is created. It can become a task later.'
                )
              : translate(
                  'nextStep.createsTask',
                  'Sending to a person creates a task card so the request has a place to live.'
                )}
        </p>
      ) : null}
      {!messageOnly && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {translate('nextStep.moreOptions', 'More options')}
          </summary>
          <div className="space-y-3 pt-2">
            {workFiles ? (
              <NextStepWorkFiles
                {...workFiles}
                deliverables={draft.handoff.deliverables}
                {...(transcript
                  ? {
                      transcript: {
                        ...transcript,
                        included: draft.handoff.includeTranscript === true,
                        onToggle: (included: boolean) =>
                          onChange({
                            handoff: { ...draft.handoff, includeTranscript: included }
                          })
                      }
                    }
                  : {})}
                onChange={(deliverables) =>
                  onChange({ handoff: { ...draft.handoff, deliverables } })
                }
              />
            ) : null}
            <WorkflowTextField
              label={translate('sessionFollowUp.due', 'Due date')}
              value={draft.handoff.dueAt ? toLocalInput(draft.handoff.dueAt) : ''}
              inputType="datetime-local"
              onChange={(value) =>
                onChange({
                  handoff: {
                    ...draft.handoff,
                    ...(value
                      ? { dueAt: new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') }
                      : { dueAt: undefined })
                  }
                })
              }
            />
          </div>
        </details>
      )}
    </div>
  )
}

function toLocalInput(iso: string): string {
  const local = new Date(iso)
  if (Number.isNaN(local.getTime())) {
    return ''
  }
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset())
  return local.toISOString().slice(0, 16)
}
