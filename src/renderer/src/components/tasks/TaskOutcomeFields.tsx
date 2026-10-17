import { Input } from '@/components/ui/input'
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
import {
  TASK_DESCRIPTION_MAX,
  taskPlanFromSteps,
  type TaskDetailsDraft,
  type TaskPlan
} from '../../../../shared/task-details'

export function TaskOutcomeFields({
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
  const plan = value.taskPlan ?? taskPlanFromSteps(value.sequentialSteps)
  const changePlan = (patch: Partial<TaskPlan>) => onChange({ taskPlan: { ...plan, ...patch } })
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-outcome`} className="text-xs">
          {translate('tasks.endOutcome', 'End outcome')}
        </Label>
        <Textarea
          id={`${idPrefix}-outcome`}
          value={value.acceptanceCriteria ?? ''}
          maxLength={TASK_DESCRIPTION_MAX}
          disabled={disabled}
          placeholder={translate(
            'tasks.endOutcomeHint',
            'What needs to be true when this task is finished?'
          )}
          onChange={(event) => onChange({ acceptanceCriteria: event.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-completion`} className="text-xs">
          {translate('tasks.completionMode', 'Completion requires')}
        </Label>
        <Select
          value={plan.completion_mode}
          disabled={disabled}
          onValueChange={(mode) => {
            if (mode === 'deliverable' || mode === 'deployment') {
              const { deployment_target: target, ...rest } = plan
              onChange({
                taskPlan:
                  mode === 'deployment'
                    ? {
                        ...rest,
                        completion_mode: mode,
                        ...(target ? { deployment_target: target } : {})
                      }
                    : { ...rest, completion_mode: mode }
              })
            }
          }}
        >
          <SelectTrigger id={`${idPrefix}-completion`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deliverable">
              {translate('tasks.completionDeliverable', 'Deliver finished work')}
            </SelectItem>
            <SelectItem value="deployment">
              {translate('tasks.completionDeployment', 'Deploy and verify')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {plan.completion_mode === 'deployment' && (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-deployment-target`} className="text-xs">
            {translate('tasks.deploymentTarget', 'Deployment target (optional)')}
          </Label>
          <Input
            id={`${idPrefix}-deployment-target`}
            value={plan.deployment_target ?? ''}
            disabled={disabled}
            maxLength={2000}
            placeholder={translate('tasks.deploymentTargetHint', 'Site, app, or environment')}
            onChange={(event) => {
              if (event.target.value.trim()) {
                changePlan({ deployment_target: event.target.value })
              } else {
                const next = { ...plan }
                delete next.deployment_target
                onChange({ taskPlan: next })
              }
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'tasks.deploymentPlanHint',
              'Records the required result. Deployment follows the task’s approved execution steps.'
            )}
          </p>
        </div>
      )}
    </section>
  )
}
