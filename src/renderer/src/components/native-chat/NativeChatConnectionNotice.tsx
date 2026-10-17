import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { describeNativeChatHistoryError } from './native-chat-history-error-copy'

/** Reading history can fail independently of the agent's execution connection. */
export function NativeChatConnectionNotice({
  error,
  onRetry
}: {
  error: string
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      data-native-chat-connection-notice
      className="border-b border-status-warning-border bg-status-warning-background px-4 py-2 text-xs"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-status-warning">
          {translate(
            'conversations.historyConnectionLost',
            'Conversation updates paused. Your loaded history is still here.'
          )}
        </span>
        {onRetry ? (
          <Button size="xs" variant="outline" onClick={onRetry}>
            {translate('conversations.retryConnection', 'Retry')}
          </Button>
        ) : null}
      </div>
      <details className="mt-1 text-muted-foreground">
        <summary className="cursor-pointer">
          {translate('chatActions.technicalDetails', 'View technical details')}
        </summary>
        <p className="mt-2 break-words">{describeNativeChatHistoryError(error)}</p>
      </details>
    </div>
  )
}
