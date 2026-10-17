import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { HandoffDetailView } from '@/components/handoffs/HandoffDetailView'
import { AgentMessageDetail } from '@/components/handoffs/AgentMessageDetail'
import { translate } from '@/i18n/i18n'
import { chatRecipientKey, type ChatRecipient } from '../../../../shared/chat-delivery'
import type { ChatDeliveryReceipt } from './chat-delivery-send'

export function ChatDeliveryStatus({
  scope,
  error,
  recipients,
  receipts,
  viewer
}: {
  scope: string
  error: string
  recipients: ChatRecipient[]
  receipts: ChatDeliveryReceipt
  viewer: string | null
}) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="whitespace-pre-wrap px-1 py-1 text-sm text-destructive">
          {error}
        </p>
      )}
      {recipients.map((recipient) => {
        const receipt = receipts[chatRecipientKey(recipient)]
        if (!receipt) {
          return null
        }
        return (
          <div
            key={chatRecipientKey(recipient)}
            className="rounded-md border border-border bg-muted/30 p-2 text-xs"
          >
            <span>
              {recipient.kind === 'agent'
                ? translate('chatDelivery.queuedTo', 'Queued for {{name}}', {
                    name: recipient.name
                  })
                : translate('chatDelivery.sentTo', 'Sent to {{name}}', { name: recipient.name })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(open === receipt.id ? null : receipt.id)}
            >
              {translate('chatDelivery.viewMessage', 'View message')}
            </Button>
            {open === receipt.id && (
              <div className="max-h-80 scrollbar-sleek overflow-y-auto border-t border-border pt-2">
                {receipt.kind === 'person' ? (
                  <HandoffDetailView scope={scope} threadId={receipt.id} viewer={viewer} />
                ) : (
                  <AgentMessageDetail scope={scope} messageId={receipt.id} viewer={viewer} />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
