import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { FollowUpTask } from './session-follow-up-draft'
import type { FollowUpLoad, FollowUpTaskList } from './use-session-follow-up-context'

/**
 * The task the request lands on: the workspace's linked OmniOS task, or one of the
 * person's own tasks chosen by title. No task id is typed and no task is created here.
 */
export function SessionFollowUpTaskPicker({
  linked,
  tasks,
  value,
  disabled,
  onChange,
  onReload
}: {
  linked: FollowUpTask | null
  tasks: FollowUpLoad<FollowUpTaskList>
  value: FollowUpTask | null
  disabled?: boolean
  onChange: (task: FollowUpTask) => void
  onReload: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const label = translate('sessionFollowUp.task', 'Task')
  if (linked) {
    return (
      <div className="space-y-1">
        <Label>{label}</Label>
        <p className="truncate text-sm">{linked.title}</p>
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'sessionFollowUp.taskLinked',
            'Linked to this workspace. The request is added to this task.'
          )}
        </p>
      </div>
    )
  }
  if (tasks.phase === 'error') {
    return (
      <div className="space-y-2">
        <Label>{label}</Label>
        <WorkflowError message={tasks.message} />
        <Button type="button" size="sm" variant="outline" onClick={onReload}>
          {translate('sessionFollowUp.retryLoad', 'Try again')}
        </Button>
      </div>
    )
  }
  const list = tasks.phase === 'ready' ? tasks.value : null
  if (list && list.tasks.length === 0 && !value) {
    return (
      <div className="space-y-1">
        <Label>{label}</Label>
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'sessionFollowUp.noTasks',
            'You have no open tasks to attach this to. Link this workspace to a task from Tasks first; creating a new task for a folder session is not available here yet.'
          )}
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="session-follow-up-task">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="session-follow-up-task"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled || !list}
            className="h-9 w-full justify-between px-3 text-sm font-normal"
          >
            <span className="truncate">
              {value?.title ??
                (list
                  ? translate('sessionFollowUp.chooseTask', 'Choose one of your tasks')
                  : translate('sessionFollowUp.loadingTasks', 'Loading your tasks…'))}
            </span>
            <ChevronsUpDown className="size-3.5 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(420px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
        >
          <Command>
            <CommandInput
              autoFocus
              placeholder={translate('sessionFollowUp.searchTasks', 'Search your tasks…')}
              className="text-xs"
            />
            <CommandList>
              <CommandEmpty>
                {translate('sessionFollowUp.noTaskMatches', 'No task matches.')}
              </CommandEmpty>
              {(list?.tasks ?? []).map((task) => (
                <CommandItem
                  key={task.id}
                  value={`${task.title} ${task.id}`}
                  onSelect={() => {
                    onChange(task)
                    setOpen(false)
                  }}
                  className="items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      value?.id === task.id ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {list?.truncated ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'sessionFollowUp.tasksTruncated',
            'Only the first page of your tasks is shown.'
          )}
        </p>
      ) : null}
    </div>
  )
}
