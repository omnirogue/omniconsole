import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ROOM_RECORD_LABELS, type RoomRecord } from './inbox-room-record'
import { translate as t } from '@/i18n/i18n'

export function InboxRoomRecord({
  record,
  openWorkflow
}: {
  record: RoomRecord
  openWorkflow?: (id: string) => void
}) {
  return (
    <div className="space-y-3">
      <Badge variant="outline">{ROOM_RECORD_LABELS[record.kind]}</Badge>
      <h4 className="text-sm font-semibold">{record.title}</h4>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{record.body}</p>
      {!!record.open_questions.length && (
        <div className="space-y-1">
          <h5 className="text-xs font-medium">{t('inbox.room.openQuestions', 'Open questions')}</h5>
          <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
            {[...new Set(record.open_questions)].map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      )}
      {record.task_id && (
        <p className="text-xs">
          {t('inbox.room.taskReference', 'Task reference:')} {record.task_id}
        </p>
      )}
      {record.supersedes_message_id && (
        <p className="text-xs text-muted-foreground">
          {t(
            'inbox.room.updatesMessageHistory',
            'Updates message: {{id}}. Earlier content remains in history.',
            { id: record.supersedes_message_id }
          )}
        </p>
      )}
      {record.kind === 'workflow_link' && record.workflow_id && openWorkflow && (
        <Button variant="outline" size="sm" onClick={() => openWorkflow(record.workflow_id!)}>
          {t('inbox.room.openWorkflow', 'Open workflow')}
        </Button>
      )}
      {!!record.source_message_ids.length && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {t('inbox.room.sourceMessages', 'Source messages')}
          </summary>
          <p className="mt-1 break-all">{record.source_message_ids.join(', ')}</p>
        </details>
      )}
    </div>
  )
}
