import { X, File, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { CommunicationTypeSelect } from '@/components/next-step/CommunicationTypeSelect'
import type { CommunicationType } from '../../../../shared/communication-type'
import {
  chatRecipientKey,
  type ChatRecipient,
  type ChatAttachment
} from '../../../../shared/chat-delivery'

export function ChatDeliveryBar({
  recipients,
  attachments,
  type,
  disabled,
  attaching,
  onType,
  onRemove,
  onRemoveAttachment,
  onFile,
  onFolder
}: {
  recipients: ChatRecipient[]
  attachments: ChatAttachment[]
  type: CommunicationType
  disabled: boolean
  attaching: boolean
  onType: (type: CommunicationType) => void
  onRemove: (id: string, kind: ChatRecipient['kind']) => void
  onRemoveAttachment: (path: string) => void
  onFile: () => void
  onFolder: () => void
}) {
  return (
    <div className="space-y-2 px-2 pt-2" data-testid="chat-delivery-bar">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{translate('chatDelivery.to', 'To')}</span>
        {recipients.map((recipient) => (
          <span
            key={chatRecipientKey(recipient)}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-accent px-2 py-1 text-xs text-accent-foreground"
          >
            @{recipient.name}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(recipient.id, recipient.kind)}
              aria-label={translate('chatDelivery.removeRecipient', 'Remove {{name}}', {
                name: recipient.name
              })}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <CommunicationTypeSelect value={type} onChange={onType} disabled={disabled} />
        <Button variant="ghost" size="sm" disabled={disabled || attaching} onClick={onFile}>
          <File className="size-3.5" />
          {translate('chatDelivery.attachFile', 'File')}
        </Button>
        <Button variant="ghost" size="sm" disabled={disabled || attaching} onClick={onFolder}>
          <Folder className="size-3.5" />
          {translate('chatDelivery.attachFolder', 'Folder')}
        </Button>
        {attaching && (
          <span role="status">{translate('chatDelivery.attaching', 'Attaching…')}</span>
        )}
      </div>
      {attachments.map((attachment) => (
        <div
          key={`${attachment.connectionId ?? 'local'}:${attachment.path}`}
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
        >
          <File className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{attachment.file.name}</span>
          <span className="text-muted-foreground" title={attachment.file.sha256}>
            {attachment.file.size.toLocaleString()} {translate('handoffs.bytesdaf52', 'bytes')} ·{' '}
            {translate('chatDelivery.version', 'Version')} {attachment.file.sha256.slice(0, 8)}
          </span>
          <button
            type="button"
            disabled={disabled}
            aria-label={translate('chatDelivery.removeAttachment', 'Remove {{name}} attachment', {
              name: attachment.file.name
            })}
            onClick={() => onRemoveAttachment(attachment.path)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
