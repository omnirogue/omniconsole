import { useState } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { CalendarProjectChoice } from './calendar-client'

export function CalendarProjectDialog({
  project,
  choices,
  initialDay,
  onClose,
  onSaved
}: {
  project: CalendarProjectChoice | null
  choices: readonly CalendarProjectChoice[]
  initialDay: string
  onClose: () => void
  onSaved: () => void
}) {
  const [selected, setSelected] = useState(project)
  const [dueDate, setDueDate] = useState(project?.dueDate ?? initialDay)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!selected || pending) {
      return
    }
    setPending(true)
    setError(null)
    try {
      workflowData(
        await consoleWorkflowApi().updateProjectDueDate({
          projectId: selected.id,
          dueDate: dueDate || null
        })
      )
      toast.success(translate('calendar.projectSaved', 'Project deadline saved'))
      onSaved()
      onClose()
    } catch (reason) {
      setError(workflowErrorMessage(reason))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{translate('calendar.projectDeadline', 'Project deadline')}</DialogTitle>
          <DialogDescription>
            {translate(
              'calendar.projectDeadlineHint',
              'Set the project’s due date. Task due dates are edited separately.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="space-y-1">
            <Label>{translate('calendar.project', 'Project')}</Label>
            {project ? (
              <p className="text-sm font-medium">{project.title}</p>
            ) : (
              <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={pickerOpen}
                    disabled={pending}
                    className="w-full justify-between font-normal"
                  >
                    <span className="truncate">
                      {selected?.title ?? translate('calendar.chooseProject', 'Choose a project')}
                    </span>
                    <ChevronsUpDown />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-96 max-w-[calc(100vw-3rem)] p-0" align="start">
                  <Command>
                    <CommandInput
                      placeholder={translate('calendar.searchProjects', 'Search projects…')}
                    />
                    <CommandList>
                      <CommandEmpty>
                        {translate('calendar.noProjects', 'No available projects found.')}
                      </CommandEmpty>
                      {choices.map((item) => (
                        <CommandItem
                          key={item.id}
                          value={`${item.title} ${item.company} ${item.domain} ${item.id}`}
                          onSelect={() => {
                            setSelected(item)
                            setDueDate(item.dueDate ?? initialDay)
                            setPickerOpen(false)
                          }}
                        >
                          <Check
                            className={cn(
                              'size-4',
                              selected?.id === item.id ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          <span>
                            <span className="block">{item.title}</span>
                            <span className="text-xs text-muted-foreground">
                              {[item.company, item.domain].filter(Boolean).join(' / ')}
                            </span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="calendar-project-due">
              {translate('calendar.dueDate', 'Due date')}
            </Label>
            <Input
              id="calendar-project-due"
              autoFocus={!!project}
              type="date"
              value={dueDate}
              disabled={pending}
              onChange={(event) => setDueDate(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {translate('calendar.removeDueHint', 'Leave blank to remove the deadline.')}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {translate('calendar.close', 'Close')}
            </Button>
            <Button type="submit" disabled={pending || !selected}>
              {pending && <Loader2 className="animate-spin" />}
              {translate('calendar.saveDeadline', 'Save deadline')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
