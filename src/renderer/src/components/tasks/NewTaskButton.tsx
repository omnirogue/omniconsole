import { useState } from 'react'
import { Lightbulb, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { CreateTaskDialog } from './CreateTaskDialog'
import type { TaskFiling } from './use-task-draft'

export function NewTaskButton({
  initialFiling,
  proposed = false,
  onCreated
}: {
  initialFiling?: TaskFiling
  /** Open the form as a proposal: the card lands on the Proposed lane. */
  proposed?: boolean
  onCreated: (taskId: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-new-task={proposed ? 'proposed' : 'task'}
      >
        {proposed ? <Lightbulb className="size-3.5" /> : <Plus className="size-3.5" />}
        {proposed
          ? translate('tasks.proposeIdeaAction', 'Propose')
          : translate('tasks.newJiraTask', 'New Jira task')}
      </Button>
      <CreateTaskDialog
        session={null}
        open={open}
        initialFiling={{ ...initialFiling, proposed }}
        onOpenChange={setOpen}
        onCreated={onCreated}
      />
    </>
  )
}
