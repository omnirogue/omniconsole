import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate as t } from '@/i18n/i18n'
import { InboxAgentAction } from './InboxAgentAction'
import { InboxContextUpdate } from './InboxContextUpdate'
import { InboxDiscussion } from './InboxDiscussion'
import { InboxRoomRecord } from './InboxRoomRecord'
import { InboxRoomWorkflow } from './InboxRoomWorkflow'
import { decodeRoomRecord } from './inbox-room-record'
import { ROOM_ACTIONS, type RoomAction } from './inbox-room-workflow'

/** One collaboration step a person opens from a discussion; each ends in a reviewed AI instruction. */
export type CollaborationRequest =
  | { kind: 'workflow'; action: RoomAction; sourcePost?: { id: string; summary: string } }
  | { kind: 'context'; sourcePostId?: string }
  | { kind: 'discussion'; workflowId?: string }

const ROOM_STEPS = ['recap', 'collect', 'compare', 'recommend'] as const
const POST_STEPS = ['decision', 'task', 'review', 'dependency'] as const

/** A structured room record renders as its record; anything else stays plain text. */
export function DiscussionPostBody({
  summary,
  onRequest
}: {
  summary: string
  onRequest: (request: CollaborationRequest) => void
}) {
  const record = decodeRoomRecord(summary)
  if (record) {
    return (
      <InboxRoomRecord
        record={record}
        openWorkflow={(workflowId) => onRequest({ kind: 'discussion', workflowId })}
      />
    )
  }
  return <p className="whitespace-pre-wrap break-words text-sm">{summary}</p>
}

export function DiscussionPostActions({
  post,
  open,
  onRequest
}: {
  post: { id: string; summary: string }
  open: boolean
  onRequest: (request: CollaborationRequest) => void
}) {
  const record = decodeRoomRecord(post.summary)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={!open}>
          {t('discussions.useMessage', 'Use message')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {record?.kind === 'context_update' && (
          <DropdownMenuItem onSelect={() => onRequest({ kind: 'context', sourcePostId: post.id })}>
            {t('discussions.shareUpdatedContext', 'Share updated context')}
          </DropdownMenuItem>
        )}
        {POST_STEPS.map((action) => (
          <DropdownMenuItem
            key={action}
            onSelect={() => onRequest({ kind: 'workflow', action, sourcePost: post })}
          >
            {ROOM_ACTIONS[action]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DiscussionWorkTogether({
  open,
  onRequest
}: {
  open: boolean
  onRequest: (request: CollaborationRequest) => void
}) {
  return (
    <section className="space-y-2 rounded-md border p-3">
      <h4 className="text-sm font-semibold">{t('discussions.workTogether', 'Work together')}</h4>
      <p className="text-xs text-muted-foreground">
        {t(
          'discussions.workTogetherHelp',
          'Run one step with your AI. Findings and recaps are posted to this discussion after a confirmed send.'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!open}
          onClick={() => onRequest({ kind: 'context' })}
        >
          {t('discussions.shareContextUpdate', 'Share context update')}
        </Button>
        {ROOM_STEPS.map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            disabled={!open}
            onClick={() => onRequest({ kind: 'workflow', action })}
          >
            {ROOM_ACTIONS[action]}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          disabled={!open}
          onClick={() => onRequest({ kind: 'discussion' })}
        >
          {t('discussions.discussionWorkflow', 'Discussion workflow')}
        </Button>
      </div>
    </section>
  )
}

/** Opens the chosen step, then shows the prepared instruction for the person's own AI. */
export function DiscussionCollaborationDialogs({
  project,
  roomId,
  roomName,
  request,
  close
}: {
  project: string
  roomId: string
  roomName: string
  request: CollaborationRequest | null
  close: () => void
}) {
  const [instruction, setInstruction] = useState<string | null>(null)
  const prepare = (text: string) => {
    close()
    setInstruction(text)
  }
  return (
    <>
      {request?.kind === 'workflow' && (
        <InboxRoomWorkflow
          project={project}
          roomId={roomId}
          action={request.action}
          sourcePost={request.sourcePost}
          close={close}
          prepare={prepare}
        />
      )}
      {request?.kind === 'context' && (
        <InboxContextUpdate
          key={`${project}:${roomId}:${request.sourcePostId ?? 'new'}`}
          project={project}
          roomId={roomId}
          sourcePostId={request.sourcePostId}
          close={close}
          prepare={prepare}
        />
      )}
      {request?.kind === 'discussion' && (
        <InboxDiscussion
          key={`${project}:${roomId}:${request.workflowId ?? 'new'}`}
          project={project}
          roomId={roomId}
          roomName={roomName}
          existingWorkflowId={request.workflowId}
          close={close}
          prepare={prepare}
        />
      )}
      {instruction && (
        <InboxAgentAction instruction={instruction} close={() => setInstruction(null)} />
      )}
    </>
  )
}
