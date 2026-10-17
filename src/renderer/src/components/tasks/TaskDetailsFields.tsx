import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { TaskStepsFields } from './TaskStepsFields'
import { TaskOutcomeFields } from './TaskOutcomeFields'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import {
  TASK_DESCRIPTION_MAX,
  taskPriority,
  taskPlanFromSteps,
  type TaskDetailsDraft
} from '../../../../shared/task-details'

export function TaskDetailsFields({
  value,
  onChange,
  disabled,
  idPrefix
}: {
  value: TaskDetailsDraft
  onChange: (patch: Partial<TaskDetailsDraft>) => void
  disabled?: boolean
  idPrefix: string
}) {
  const roster = useHandoffPeople()
  const plan = value.taskPlan ?? taskPlanFromSteps(value.sequentialSteps)
  const people = roster.people.phase === 'ready' ? roster.people.value : []
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-title`} className="text-xs">
          {translate('tasks.name', 'Task')}
        </Label>
        <Input
          id={`${idPrefix}-title`}
          value={value.title}
          maxLength={500}
          disabled={disabled}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-notes`} className="text-xs">
          {translate('tasks.notes', 'Notes (optional)')}
        </Label>
        <Textarea
          id={`${idPrefix}-notes`}
          value={value.description}
          maxLength={TASK_DESCRIPTION_MAX}
          className="min-h-24"
          disabled={disabled}
          placeholder={translate(
            'tasks.notesPlaceholder',
            'The outcome, useful context, and what needs to be done.'
          )}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </div>
      <TaskOutcomeFields
        value={value}
        onChange={onChange}
        disabled={disabled}
        idPrefix={idPrefix}
      />
      <TaskStepsFields
        value={plan.steps}
        people={people}
        disabled={disabled}
        onChange={(steps) =>
          onChange({
            taskPlan: { ...plan, steps },
            sequentialSteps: steps.map((step) => step.title)
          })
        }
      />
      {roster.people.phase === 'error' && (
        <div className="space-y-1 text-xs">
          <p role="status" className="text-muted-foreground">
            {roster.people.message}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={roster.reload}
            disabled={disabled}
          >
            {translate('tasks.reloadPeople', 'Reload people')}
          </Button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-due`} className="text-xs">
            {translate('tasks.dueDate', 'Due date (optional)')}
          </Label>
          <Input
            id={`${idPrefix}-due`}
            type="date"
            value={value.dueDate.slice(0, 10)}
            disabled={disabled}
            onChange={(event) => onChange({ dueDate: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-priority`} className="text-xs">
            {translate('tasks.priority', 'Priority')}
          </Label>
          <Select
            value={value.priority}
            disabled={disabled}
            onValueChange={(priority) => onChange({ priority: taskPriority.parse(priority) })}
          >
            <SelectTrigger id={`${idPrefix}-priority`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">{translate('tasks.priorityLow', 'Low')}</SelectItem>
              <SelectItem value="normal">{translate('tasks.priorityNormal', 'Normal')}</SelectItem>
              <SelectItem value="high">{translate('tasks.priorityHigh', 'High')}</SelectItem>
              <SelectItem value="urgent">{translate('tasks.priorityUrgent', 'Urgent')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  )
}
