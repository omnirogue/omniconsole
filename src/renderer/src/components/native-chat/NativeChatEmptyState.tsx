import { LoaderCircle, MessageSquare, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { describeNativeChatHistoryError } from './native-chat-history-error-copy'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { NATIVE_CHAT_EMPTY_STATE_COPY } from '../../../../shared/native-chat-empty-state'
import type { NativeChatSession } from '../../../../shared/native-chat-types'

export function NativeChatEmptyState({
  kind,
  message,
  agent,
  onRetry
}: {
  kind: 'loading' | 'empty' | 'error' | 'not-agent'
  message?: string
  agent?: NativeChatSession['agent']
  onRetry?: () => void
}): React.JSX.Element {
  const copy = emptyStateCopy(kind, agent)
  return (
    <div
      role="status"
      className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <div
        className={
          kind === 'error'
            ? 'flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive'
            : 'flex size-12 items-center justify-center rounded-full bg-status-info-background text-status-info'
        }
      >
        {kind === 'error' ? (
          <TriangleAlert className="size-6" />
        ) : kind === 'loading' ? (
          <LoaderCircle className="size-6 motion-safe:animate-spin" />
        ) : (
          <MessageSquare className="size-6" />
        )}
      </div>
      <p className="text-sm font-medium text-foreground">{copy.title}</p>
      {copy.subtitle ? (
        <p className="max-w-sm text-balance text-xs text-muted-foreground">{copy.subtitle}</p>
      ) : null}
      {kind === 'error' && onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {translate('conversations.retryConnection', 'Retry')}
        </Button>
      ) : null}
      {kind === 'error' && message ? (
        <details className="max-w-sm text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {translate('chatActions.technicalDetails', 'View technical details')}
          </summary>
          <p className="mt-2 break-words">{describeNativeChatHistoryError(message)}</p>
        </details>
      ) : null}
    </div>
  )
}

function emptyStateCopy(
  kind: 'loading' | 'empty' | 'error' | 'not-agent',
  agent?: NativeChatSession['agent']
): { title: string; subtitle: string | null } {
  switch (kind) {
    case 'loading':
      return {
        title: translate(
          'components.native-chat.state.loading.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.title
        ),
        subtitle: translate(
          'components.native-chat.state.loading.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.subtitle
        )
      }
    case 'error':
      return {
        title: translate(
          'components.native-chat.state.error.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.error.title
        ),
        subtitle: translate(
          'components.native-chat.state.error.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.error.subtitle
        )
      }
    case 'not-agent':
      return {
        title: translate(
          'components.native-chat.state.notAgent.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.title
        ),
        subtitle: translate(
          'components.native-chat.state.notAgent.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.subtitle
        )
      }
    case 'empty': {
      const agentName = agent ? formatAgentTypeLabel(agent) : 'the agent'
      return {
        title: translate(
          'components.native-chat.state.empty.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.title,
          { agent: agentName }
        ),
        subtitle: translate(
          'components.native-chat.state.empty.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.subtitle
        )
      }
    }
  }
}
