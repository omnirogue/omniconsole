import { HandoffFilePicker } from '@/components/handoffs/HandoffFilePicker'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { useTaskAttachments } from './use-task-attachments'

export function TaskAttachmentFields({
  attachments,
  disabled
}: {
  attachments: ReturnType<typeof useTaskAttachments>
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <HandoffFilePicker
        disabled={disabled}
        onFile={attachments.add}
        onPendingChange={attachments.setCapturing}
      />
      {attachments.entries.length > 0 && (
        <ul className="space-y-2">
          {attachments.entries.map((entry) => (
            <li key={`${entry.file.name}:${entry.file.sha256}`} className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 break-all">{entry.file.name}</span>
                {entry.saved ? (
                  <span className="text-muted-foreground">
                    {translate('tasks.fileAttached', 'Attached')}
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={disabled}
                    onClick={() => attachments.remove(entry.file)}
                  >
                    {translate('common.remove', 'Remove')}
                  </Button>
                )}
              </div>
              {entry.error && (
                <p role="alert" className="text-destructive">
                  {entry.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
