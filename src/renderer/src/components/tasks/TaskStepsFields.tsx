import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { TaskPlanStep } from '../../../../shared/task-details'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { TaskStepPeople } from './TaskStepPeople'

/** Stable step identities keep people attached when the plan is reordered. */
export function TaskStepsFields({
  value,
  onChange,
  disabled,
  people
}: {
  value: TaskPlanStep[]
  onChange: (steps: TaskPlanStep[]) => void
  people: readonly TeamRosterPerson[]
  disabled?: boolean
}) {
  const move = (index: number, offset: number) => {
    const next = [...value]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    onChange(next)
  }
  return (
    <section className="space-y-2" aria-label={translate('tasks.steps', 'Steps (optional)')}>
      <p className="text-xs font-medium">{translate('tasks.steps', 'Steps (optional)')}</p>
      <ol className="space-y-2">
        {value.map((step, index) => (
          <li key={step.id} className="flex items-start gap-2">
            <span className="pt-2 text-xs tabular-nums text-muted-foreground">{index + 1}.</span>
            <div className="min-w-0 flex-1 space-y-2">
              <Textarea
                value={step.title}
                maxLength={2000}
                disabled={disabled}
                className="min-h-16 flex-1"
                aria-label={translate('tasks.stepNumber', 'Step {{number}}', { number: index + 1 })}
                placeholder={translate(
                  'tasks.stepPlaceholder',
                  'What needs to happen, and who can help?'
                )}
                onChange={(event) =>
                  onChange(
                    value.map((item, at) =>
                      at === index ? { ...item, title: event.target.value } : item
                    )
                  )
                }
              />
              <TaskStepPeople
                value={step.actor_ids}
                people={people}
                number={index + 1}
                disabled={disabled}
                onChange={(actor_ids) =>
                  onChange(value.map((item, at) => (at === index ? { ...item, actor_ids } : item)))
                }
              />
            </div>
            <div className="flex flex-col">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled || index === 0}
                aria-label={translate('tasks.stepUp', 'Move step {{number}} up', {
                  number: index + 1
                })}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled || index === value.length - 1}
                aria-label={translate('tasks.stepDown', 'Move step {{number}} down', {
                  number: index + 1
                })}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={translate('tasks.stepRemove', 'Remove step {{number}}', {
                  number: index + 1
                })}
                onClick={() => {
                  onChange(value.filter((_, at) => at !== index))
                }}
              >
                <X className="size-3" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || value.length >= 100}
        onClick={() => {
          onChange([...value, { id: crypto.randomUUID(), title: '', actor_ids: [] }])
        }}
      >
        <Plus className="size-3.5" />
        {translate('tasks.addStep', 'Add step')}
      </Button>
    </section>
  )
}
