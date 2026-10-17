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
import { WorkflowComposer } from '@/components/console-workflows/WorkflowComposer'
import { WorkflowDetail } from '@/components/console-workflows/WorkflowDetail'
import type { WorkflowDraft } from '@/lib/console-workflow-draft'
import { InboxRoomPicker } from './InboxRoomPicker'
import { roomTaskContexts, type RoomContext } from './inbox-room-context'
import { roomDiscussionDraft } from './inbox-discussion-draft'
import { encodeRoomRecord } from './inbox-room-record'
import { peerInstruction } from './inbox-handoff'
import { translate as t } from '@/i18n/i18n'

export function InboxDiscussion({
  project,
  roomId,
  roomName,
  existingWorkflowId,
  close,
  prepare
}: {
  project: string
  roomId: string
  roomName: string
  existingWorkflowId?: string
  close: () => void
  prepare: (text: string) => void
}) {
  const [tasks, setTasks] = useState<RoomContext[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState(roomName)
  const [outcome, setOutcome] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<WorkflowDraft | null>(null)
  const [workflowId, setWorkflowId] = useState(existingWorkflowId)
  const [linkInstruction, setLinkInstruction] = useState('')
  useEffect(() => {
    if (existingWorkflowId) {
      return
    }
    let live = true
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
      .catch((reason) => {
        if (live) {
          setError(String(reason))
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
  }, [project, existingWorkflowId])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-sleek sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('inbox.room.discussionWorkflow', 'Discussion workflow')}</DialogTitle>
          <DialogDescription>
            {t(
              'inbox.room.collectAvailableContributionsCompareThemRecommend',
              'Collect available contributions, compare them, recommend a next step, then wait for a human decision.'
            )}
          </DialogDescription>
        </DialogHeader>
        {workflowId ? (
          <>
            {linkInstruction && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm">
                  {t(
                    'inbox.room.workflowAdmittedShareItsReferenceWith',
                    'Workflow admitted. Share its reference with the room so members can reopen it.'
                  )}
                </p>
                <Button onClick={() => prepare(linkInstruction)}>
                  {t('inbox.room.reviewRoomLink', 'Review room link')}
                </Button>
              </div>
            )}
            <WorkflowDetail key={workflowId} workflowId={workflowId} />
          </>
        ) : draft ? (
          <WorkflowComposer
            initialTaskId={draft.taskId}
            initialDraft={draft}
            onAdmitted={(id) => {
              setWorkflowId(id)
              setLinkInstruction(
                peerInstruction(project, 'room_send', {
                  room_id: roomId,
                  summary: encodeRoomRecord({
                    kind: 'workflow_link',
                    title: t('inbox.room.discussionWorkflow', 'Discussion workflow'),
                    body: 'Open the workflow to read its current execution state and any human decision required. Admission alone does not mean its stages have run.',
                    source_message_ids: [],
                    open_questions: [],
                    workflow_id: id
                  })
                })
              )
            }}
          />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              const taskId = tasks.find((task) => task.key === selected[0])?.reference.task_id
              if (!taskId || loading || !title.trim() || !outcome.trim()) {
                return
              }
              setDraft(
                roomDiscussionDraft({
                  project,
                  roomId,
                  taskId,
                  title: title.trim(),
                  outcome: outcome.trim()
                })
              )
            }}
          >
            <InboxRoomPicker
              label={t('inbox.room.existingTask', 'Existing task')}
              groups={[
                {
                  label: t('inbox.room.tasks', 'Tasks'),
                  options: tasks,
                  notice: loading ? 'Loading tasks…' : 'Choose the task that owns this discussion.'
                }
              ]}
              selected={tasks.filter((task) => selected.includes(task.key))}
              onChange={(keys) => setSelected(keys.slice(-1))}
            />
            <Label htmlFor="discussion-title">{t('inbox.room.title', 'Title')}</Label>
            <Input
              id="discussion-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={160}
            />
            <Label htmlFor="discussion-outcome">
              {t('inbox.room.expectedResult', 'Expected result')}
            </Label>
            <Textarea
              id="discussion-outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              required
              maxLength={1600}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                'inbox.room.chooseModelsExecutionLocationAndThe',
                'Choose models, execution location and the decision owner in the workflow preview. This uses existing room contributions; it does not wake other members’ private sessions. No spending limit is configured by this template.'
              )}
            </p>
            <Button type="submit" disabled={loading || !selected.length || !!error}>
              {t('inbox.room.configureWorkflow', 'Configure workflow')}
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
