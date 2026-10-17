import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { InboxRoomPicker } from './InboxRoomPicker'
import { useInboxPeopleState } from './use-inbox-people'
import { roomTaskContexts, type RoomContext } from './inbox-room-context'
import { ROOM_ACTIONS, roomWorkflowInstruction, type RoomAction } from './inbox-room-workflow'
import { translate as t } from '@/i18n/i18n'

export function InboxRoomWorkflow({
  project,
  roomId,
  action,
  sourcePost,
  close,
  prepare
}: {
  project: string
  roomId: string
  action: RoomAction
  sourcePost?: { id: string; summary: string }
  close: () => void
  prepare: (text: string) => void
}) {
  const [title, setTitle] = useState('')
  const [request, setRequest] = useState('')
  const [recipient, setRecipient] = useState<string[]>([])
  const [task, setTask] = useState<string[]>([])
  const [tasks, setTasks] = useState<RoomContext[]>([])
  const [revision, setRevision] = useState(0)
  const [taskError, setTaskError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const people = useInboxPeopleState(revision)
  const targeted = action === 'review' || action === 'dependency'
  useEffect(() => {
    if (!targeted) {
      return
    }
    let live = true
    setLoading(true)
    setTaskError('')
    void window.api.backoffice
      .listTodo()
      .then((result) => {
        if (!live) {
          return
        }
        if (!result.ok) {
          throw new Error(result.message)
        }
        setTasks(roomTaskContexts(result.items, project))
      })
      .catch((reason: unknown) => {
        if (live) {
          setTaskError(String(reason))
          setTasks([])
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [project, targeted, revision])
  const options = people.people.map((person) => ({
    key: person.employee_id,
    title: person.name,
    detail: person.enrolled ? 'AI Inbox connected' : 'AI setup may be required'
  }))
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ROOM_ACTIONS[action]}</DialogTitle>
          <DialogDescription>
            {t(
              'inbox.room.yourAiPerformsOneReviewedStep',
              'Your AI performs one reviewed step and returns the service result. Another round requires a new instruction.'
            )}
          </DialogDescription>
        </DialogHeader>
        {sourcePost && (
          <details className="rounded-md border p-3 text-xs">
            <summary className="cursor-pointer">
              {t('inbox.room.sourceMessage', 'Source message')}
            </summary>
            <p className="mt-2 whitespace-pre-wrap break-words">{sourcePost.summary}</p>
          </details>
        )}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            try {
              if (
                targeted &&
                (loading ||
                  people.loading ||
                  people.error ||
                  taskError ||
                  !options.some((item) => item.key === recipient[0]) ||
                  !tasks.some((item) => item.key === task[0]))
              ) {
                throw new Error('Reload and choose a colleague and task available in this project.')
              }
              prepare(
                roomWorkflowInstruction({
                  project,
                  roomId,
                  action,
                  sourcePostId: sourcePost?.id,
                  title,
                  request,
                  recipient: recipient[0],
                  taskId:
                    tasks.find((item) => item.key === task[0])?.reference.task_id ?? undefined,
                  idempotencyKey: key
                })
              )
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="room-action-title">{t('inbox.room.title', 'Title')}</Label>
            <Input
              id="room-action-title"
              required
              autoFocus
              maxLength={160}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="room-action-request">
              {t('inbox.room.requestedOutcome', 'Requested outcome')}
            </Label>
            <Textarea
              id="room-action-request"
              required
              rows={4}
              maxLength={1600}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
            />
          </div>
          {targeted && (
            <>
              <InboxRoomPicker
                label={t('inbox.room.colleague', 'Colleague')}
                groups={[
                  {
                    label: t('inbox.room.colleagues', 'Colleagues'),
                    options,
                    notice: people.error || 'Choose one recipient.',
                    retry: () => setRevision((value) => value + 1)
                  }
                ]}
                selected={options.filter((item) => recipient.includes(item.key))}
                onChange={(keys) => setRecipient(keys.slice(-1))}
              />
              <InboxRoomPicker
                label={t('inbox.room.existingTask', 'Existing task')}
                groups={[
                  {
                    label: t('inbox.room.tasks', 'Tasks'),
                    options: tasks,
                    notice: taskError || 'Your loaded tasks in this project.',
                    retry: () => setRevision((value) => value + 1)
                  }
                ]}
                selected={tasks.filter((item) => task.includes(item.key))}
                onChange={(keys) => setTask(keys.slice(-1))}
              />
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              {t('inbox.room.cancel', 'Cancel')}
            </Button>
            <Button type="submit">
              {t('inbox.room.reviewAiInstruction', 'Review AI instruction')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
