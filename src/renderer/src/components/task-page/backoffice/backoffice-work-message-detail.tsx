import { NextStepMessagePanel } from '@/components/next-step/NextStepMessagePanel'
import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AddNextButton } from '@/components/next-step/AddNextButton'
import { translate } from '@/i18n/i18n'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import type { PeerMessageThread } from '../../../../../shared/peer-message-contract'
import { personName } from './backoffice-work-labels'
import { useBackofficeWorkStore } from './backoffice-work-store'
import { AgentMessageDetail } from '@/components/handoffs/AgentMessageDetail'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'

function when(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toLocaleString()
}

function useLoadedCard(taskId: string | null) {
  return useBackofficeWorkStore((state) => {
    if (!taskId) {
      return null
    }
    const feed = state.todo.phase === 'ready' ? state.todo.value : null
    return feed?.items.find((item) => item.task_id === taskId) ?? null
  })
}

/** Peer history and replies use the original message; Add Next continues its linked work. */
export function BackofficeWorkMessageDetail({
  row,
  message,
  names,
  baseUrl,
  onOpenTask,
  onChanged,
  viewer
}: {
  row: WorkRow
  message: PeerMessageThread
  names: ReadonlyMap<string, string>
  baseUrl: string | null
  onOpenTask: (taskId: string) => void
  onChanged: () => void
  viewer?: string | null
}): React.JSX.Element {
  const card = useLoadedCard(row.taskId)
  const scope = useHandoffScope()
  const { employeeId } = useHandoffPeople()
  if (message.communication_type && message.task_id === null) {
    return (
      <AgentMessageDetail
        scope={scope}
        messageId={message.id}
        viewer={employeeId}
        onChanged={onChanged}
      />
    )
  }
  const sender = personName(message.sender_employee_id, names)
  const recipient = personName(message.recipient_employee_id, names)
  const moments: [string, number | null][] = [
    [translate('backofficeWork.messageQueued', 'Asked'), message.created_at],
    [translate('backofficeWork.messageDelivered', 'Delivered'), message.delivered_at],
    [translate('backofficeWork.messageReplied', 'Answered'), message.replied_at],
    [translate('backofficeWork.messageResolved', 'Resolved'), message.resolved_at]
  ]
  return (
    <div className="space-y-3" data-work-message={message.id}>
      <div className="flex flex-wrap items-center gap-1.5">
        {card ? <AddNextButton subject={{ kind: 'card', item: card }} onSent={onChanged} /> : null}
        <Badge variant="outline">{message.state}</Badge>
        {row.taskId ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenTask(row.taskId!)}>
            {translate('backofficeWork.messageOpenCard', 'Open its card')}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {sender} → {recipient}
      </p>
      <article className="rounded-md border bg-card p-3">
        <p className="whitespace-pre-wrap break-words text-sm">{message.summary}</p>
      </article>
      {viewer === message.recipient_employee_id &&
        !message.reply &&
        (message.state === 'queued' || message.state === 'delivered') && (
          <NextStepMessagePanel
            messageTarget={{ kind: 'peer', id: message.id, title: sender }}
            onSent={onChanged}
          />
        )}
      {message.reply ? (
        <article className="rounded-md border bg-muted/30 p-3">
          <p className="mb-1 text-xs text-muted-foreground">
            {translate('backofficeWork.messageReplyFrom', 'Answer from {{person}}', {
              person: recipient
            })}
            {' · '}
            {when(message.reply.created_at)}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{message.reply.summary}</p>
        </article>
      ) : null}
      <dl className="grid gap-1 text-xs sm:grid-cols-2">
        {moments
          .filter((moment): moment is [string, number] => moment[1] !== null)
          .map(([label, at]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{when(at)}</dd>
            </div>
          ))}
      </dl>
      {!card && viewer !== message.recipient_employee_id ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'backofficeWork.messageAnswerInConsole',
            'The answer goes through the Console; this desktop reads messages only.'
          )}{' '}
          {baseUrl ? (
            <a
              className="inline-flex items-center gap-1 font-medium underline"
              href={`${baseUrl}/work`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="size-3" />
              {translate('backofficeWork.openInConsole', 'Open in the Console')}
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
