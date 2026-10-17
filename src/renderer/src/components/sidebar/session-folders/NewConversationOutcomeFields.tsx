import { useEffect, useId } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  newConversationPlansTeam,
  useLaunchTaskChoices,
  type NewConversationOutcomeDraft
} from './new-conversation-outcome'

const NO_TASK = "__no-task__"

export function NewConversationOutcomeFields({
  value,
  onChange,
  enabled,
  scope
}: {
  value: NewConversationOutcomeDraft
  onChange: (next: NewConversationOutcomeDraft) => void
  enabled: boolean
  /** Account scope these cards belong to; a switch re-reads them and drops a stale choice. */
  scope: string
}): React.JSX.Element {
  const id = useId()
  const { tasks, error } = useLaunchTaskChoices(enabled, scope)
  const hasOutcome = value.outcome.trim().length > 0
  const planMode = newConversationPlansTeam(value)
  // Why: a card chosen under the previous account scope must never ride along into this launch.
  useEffect(() => {
    if (value.taskId && tasks && !tasks.some((task) => task.id === value.taskId)) {
      onChange({ ...value, taskId: '' })
    }
  }, [onChange, tasks, value])
  return (
    <div className="space-y-2" data-new-conversation-outcome="">
      <div className="space-y-1">
        <Label htmlFor={`${id}-outcome`} className="text-xs">
          {translate('conversations.outcome', 'Outcome')}
        </Label>
        <Textarea
          id={`${id}-outcome`}
          value={value.outcome}
          rows={2}
          maxLength={4000}
          className="min-h-14 text-xs md:text-xs"
          placeholder={translate(
            'conversations.outcomePlaceholder',
            'Optional: what must be true when this is done'
          )}
          onChange={(event) => onChange({ ...value, outcome: event.target.value })}
        />
      </div>
      <Select
        value={value.taskId || NO_TASK}
        onValueChange={(next) => onChange({ ...value, taskId: next === NO_TASK ? '' : next })}
      >
        <SelectTrigger
          size="sm"
          className="w-full text-xs"
          aria-label={translate('conversations.partOfTask', 'Part of task')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_TASK}>
            {translate('conversations.noParentTask', 'Not part of a task')}
          </SelectItem>
          {tasks === null ? (
            <SelectItem value="__loading__" disabled>
              {translate('tasks.loading', 'Reading your work…')}
            </SelectItem>
          ) : null}
          {tasks?.map((task) => (
            <SelectItem key={task.id} value={task.id}>
              {task.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`${id}-team`} className="text-xs font-normal">
          {translate('conversations.planTheTeam', 'Plan the team')}
        </Label>
        <Switch
          id={`${id}-team`}
          checked={planMode}
          disabled={!hasOutcome}
          onCheckedChange={(checked) => onChange({ ...value, planMode: checked })}
        />
      </div>
      {planMode ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'conversations.planTheTeamHelp',
            'The agent sizes the work and commits its implementers, reviewers and rounds before it starts.'
          )}
        </p>
      ) : null}
    </div>
  )
}
