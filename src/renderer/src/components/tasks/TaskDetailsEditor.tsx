import { useRef, useState } from 'react'
import { Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useConsoleTask } from '@/components/console-workflows/TaskNextActionEditor'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ConsoleTaskRecord } from '../../../../shared/console-workflow-types'
import {
  taskPriority,
  type TaskDetailsDraft,
  type TaskDetailsPatch
} from '../../../../shared/task-details'
import { TaskDetailsFields } from './TaskDetailsFields'
import { TaskAttachmentFields } from './TaskAttachmentFields'
import { useTaskAttachments } from './use-task-attachments'

export function TaskDetailsEditor({
  taskId,
  onSaved,
  initiallyOpen = false
}: {
  taskId: string
  onSaved: () => void
  initiallyOpen?: boolean
}) {
  const scope = useAppStore(selectConsoleAccountScope)
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" />
        {translate('tasks.editDetails', 'Edit task')}
      </Button>
      {open && (
        <EditTaskDialog
          key={`${scope}:${taskId}`}
          taskId={taskId}
          scope={scope}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      )}
    </>
  )
}

function EditTaskDialog({
  taskId,
  scope,
  onClose,
  onSaved
}: {
  taskId: string
  scope: string
  onClose: () => void
  onSaved: () => void
}) {
  const { task, loading, error, refresh } = useConsoleTask(taskId)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[85vh] min-w-0 overflow-y-auto scrollbar-sleek sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('tasks.editDetails', 'Edit task')}
          </DialogTitle>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-xs text-muted-foreground">
            {translate('tasks.loading', 'Reading task…')}
          </p>
        ) : (
          task && (
            <EditTaskForm
              key={`${task.id}:${task.state_revision}`}
              task={task}
              scope={scope}
              onSaved={onSaved}
              onClose={onClose}
              onBusy={setBusy}
            />
          )
        )}
        <Button variant="ghost" size="sm" disabled={busy || loading} onClick={() => void refresh()}>
          {translate('tasks.reloadDetails', 'Reload saved task')}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

function initialDetails(task: ConsoleTaskRecord): TaskDetailsDraft {
  return {
    title: task.title,
    description: task.description ?? '',
    acceptanceCriteria: task.acceptance_criteria ?? '',
    taskPlan: task.task_plan ?? undefined,
    dueDate: task.due_date ?? '',
    priority: taskPriority.safeParse(task.priority).data ?? 'normal',
    sequentialSteps: task.sequential_steps ?? []
  }
}

function EditTaskForm({
  task,
  scope,
  onClose,
  onSaved,
  onBusy
}: {
  task: ConsoleTaskRecord
  scope: string
  onClose: () => void
  onSaved: () => void
  onBusy: (busy: boolean) => void
}) {
  const [draft, setDraft] = useState(() => initialDetails(task))
  const [saved, setSaved] = useState(() => ({
    fields: initialDetails(task),
    revision: task.state_revision,
    principal: task.publicationPrincipal
  }))
  const attachments = useTaskAttachments()
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState('')
  const current = () => selectConsoleAccountScope(useAppStore.getState()) === scope
  const changes: TaskDetailsPatch = {}
  if (draft.title.trim() !== saved.fields.title) {
    changes.title = draft.title.trim()
  }
  if (draft.description !== saved.fields.description) {
    changes.description = draft.description
  }
  if (draft.acceptanceCriteria !== saved.fields.acceptanceCriteria) {
    changes.acceptanceCriteria = draft.acceptanceCriteria ?? ''
  }
  if (JSON.stringify(draft.taskPlan) !== JSON.stringify(saved.fields.taskPlan)) {
    changes.taskPlan = draft.taskPlan
  }
  if (draft.dueDate !== saved.fields.dueDate) {
    changes.dueDate = draft.dueDate || null
  }
  if (draft.priority !== saved.fields.priority) {
    changes.priority = draft.priority
  }
  if (JSON.stringify(draft.sequentialSteps) !== JSON.stringify(saved.fields.sequentialSteps)) {
    changes.sequentialSteps = draft.sequentialSteps
  }
  const save = async () => {
    if (saving.current || attachments.capturing || saved.revision == null || !current()) {
      return
    }
    saving.current = true
    setBusy(true)
    onBusy(true)
    setError('')
    try {
      let principal = saved.principal
      if (Object.keys(changes).length) {
        const response = workflowData(
          await consoleWorkflowApi().updateTask({
            taskId: task.id,
            expectedRevision: saved.revision,
            ...changes
          })
        )
        if (!current()) {
          return
        }
        if (
          !response ||
          typeof response !== 'object' ||
          Array.isArray(response) ||
          response.taskId !== task.id ||
          typeof response.stateRevision !== 'number'
        ) {
          throw new Error(
            'This desktop could not confirm the saved task. Reload it before continuing.'
          )
        }
        principal = typeof response.principal === 'string' ? response.principal : undefined
        const fields = {
          ...draft,
          title: draft.title.trim(),
          sequentialSteps: draft.sequentialSteps.map((step) => step.trim()),
          ...(draft.taskPlan
            ? {
                taskPlan: {
                  ...draft.taskPlan,
                  steps: draft.taskPlan.steps.map((step) => ({ ...step, title: step.title.trim() }))
                }
              }
            : {})
        }
        setDraft(fields)
        setSaved({
          fields,
          revision: response.stateRevision,
          principal
        })
        onSaved()
      }
      const uploaded = await attachments.upload(task.id, principal)
      if (!current()) {
        return
      }
      onSaved()
      if (!uploaded) {
        setError(
          translate(
            'tasks.filesPending',
            'The task is saved. Retry the remaining files, or close and attach them from the task later.'
          )
        )
        return
      }
      onClose()
    } catch (reason) {
      if (current()) {
        setError(workflowErrorMessage(reason))
      }
    } finally {
      saving.current = false
      setBusy(false)
      onBusy(false)
    }
  }
  return (
    <>
      <TaskDetailsFields
        value={draft}
        onChange={(patch) => setDraft((value) => ({ ...value, ...patch }))}
        disabled={busy}
        idPrefix="edit-task"
      />
      <TaskAttachmentFields attachments={attachments} disabled={busy} />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {saved.revision == null && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'consoleWorkflows.noRevision',
            'This server view has no task revision; changes are unavailable.'
          )}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          {translate('common.close', 'Close')}
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={
            busy ||
            attachments.capturing ||
            saved.revision == null ||
            !draft.title.trim() ||
            (!Object.keys(changes).length && !attachments.pending)
          }
        >
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {translate('common.saveChanges', 'Save changes')}
        </Button>
      </DialogFooter>
    </>
  )
}
