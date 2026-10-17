import { NextStepMessagePanel } from '@/components/next-step/NextStepMessagePanel'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate as t } from '@/i18n/i18n'
import { readPeerRoom, readPeerRoomMessages } from '@/lib/peer-rooms'
import type { PeerRoomDetail, PeerRoomPost } from '../../../../../shared/peer-room-contract'
import {
  DiscussionCollaborationDialogs,
  DiscussionPostActions,
  DiscussionPostBody,
  DiscussionWorkTogether,
  type CollaborationRequest
} from '@/components/inbox/DiscussionCollaboration'

export function BackofficeDiscussionDetail({
  project,
  roomId,
  onOpenTask
}: {
  project: string
  roomId: string
  onOpenTask: (id: string) => void
}) {
  const [revision, setRevision] = useState(0)
  const [detail, setDetail] = useState<PeerRoomDetail | null>(null)
  const [posts, setPosts] = useState<PeerRoomPost[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [next, setNext] = useState<string | null>(null)
  const [pending, setPending] = useState(true)
  const [error, setError] = useState('')
  const [request, setRequest] = useState<CollaborationRequest | null>(null)
  useEffect(() => {
    let live = true
    setPending(true)
    void Promise.all([readPeerRoom(project, roomId), readPeerRoomMessages(roomId, cursor)])
      .then(
        ([value, page]) => {
          if (live) {
            setDetail(value)
            setPosts((current) => [
              ...new Map([...current, ...page.posts].map((post) => [post.id, post])).values()
            ])
            setNext(page.next_cursor === cursor ? null : page.next_cursor)
            setError('')
          }
        },
        (reason: unknown) => {
          if (live) {
            setDetail(null)
            setPosts([])
            setNext(null)
            setError(String(reason))
          }
        }
      )
      .finally(() => {
        if (live) {
          setPending(false)
        }
      })
    return () => {
      live = false
    }
  }, [project, roomId, cursor, revision])
  const name = (id: string) =>
    detail?.members.find((member) => member.employee_id === id)?.employee_name || id
  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {pending && (
        <p role="status">{t('discussions.loadingHistory', 'Loading discussion history…')}</p>
      )}
      {detail && (
        <>
          <h3 className="text-sm font-semibold">{detail.room.name}</h3>
          {detail.room.state === 'open' && (
            <NextStepMessagePanel
              messageTarget={{ kind: 'room', id: roomId, title: detail.room.name }}
              onSent={() => {
                setPosts([])
                setCursor(undefined)
                setRevision((value) => value + 1)
              }}
            />
          )}
          <DiscussionWorkTogether open={detail.room.state === 'open'} onRequest={setRequest} />
          <Button variant="outline" size="sm" onClick={() => onOpenTask(detail.room.task_id)}>
            {t('discussions.openWork', 'Open linked work')}
          </Button>
          <ul className="text-xs text-muted-foreground">
            {detail.members.map((member) => (
              <li key={member.id}>
                {member.employee_name} · {member.label} · {member.presence}
              </li>
            ))}
          </ul>
          {detail.members_truncated && (
            <p className="text-xs">
              {t(
                'discussions.membersLimited',
                'Additional members are not included in this response.'
              )}
            </p>
          )}
          {!pending && !posts.length && (
            <p>{t('discussions.noMessages', 'No messages returned.')}</p>
          )}
          <ol className="space-y-3">
            {posts.map((post) => (
              <li key={post.id} className="space-y-2 rounded-md border bg-card p-3">
                <p className="text-xs text-muted-foreground">
                  {name(post.sender_employee_id)} ·{' '}
                  {new Date(post.created_at * 1000).toLocaleString()}
                </p>
                <DiscussionPostBody summary={post.summary} onRequest={setRequest} />
                {post.references.map((reference) => (
                  <a
                    key={reference}
                    className="block break-all text-xs underline"
                    href={reference}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {reference}
                  </a>
                ))}
                <DiscussionPostActions
                  post={post}
                  open={detail.room.state === 'open'}
                  onRequest={setRequest}
                />
                <ul className="space-y-1 text-xs">
                  {post.deliveries.map((delivery) => (
                    <li key={delivery.id}>
                      {name(delivery.recipient_employee_id)} · {delivery.state}
                      {delivery.reply && (
                        <p className="whitespace-pre-wrap break-words">{delivery.reply.summary}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {next && (
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setCursor(next)}>
              {t('discussions.older', 'Load older messages')}
            </Button>
          )}
          <DiscussionCollaborationDialogs
            project={project}
            roomId={roomId}
            roomName={detail.room.name}
            request={request}
            close={() => setRequest(null)}
          />
        </>
      )}
    </div>
  )
}
