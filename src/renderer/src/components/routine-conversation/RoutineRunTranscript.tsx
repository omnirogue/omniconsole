import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { BoardConversationTurn } from '../../../../shared/console-routine-conversation-contract'
import { sameTurn, turnText } from './routine-conversation-data'
import { useRoutineConversation } from './use-routine-conversation'
import { RoutineConversationComposer } from './RoutineConversationComposer'

export function RoutineRunTranscript({
  taskId,
  active,
  refreshRuns,
  posted
}: {
  taskId: string
  active: boolean
  refreshRuns: () => Promise<void>
  posted: Map<string, BoardConversationTurn[]>
}) {
  const { messages, error, loading, refresh } = useRoutineConversation(taskId, active, refreshRuns)
  const [, rerender] = useState(0)
  const own = posted.get(taskId) ?? []
  // Cached reads may lag behind a successful write; retain the acknowledged turn.
  const turns = [
    ...messages,
    ...own.filter((turn) => !messages.some((message) => sameTurn(turn, message)))
  ].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  return (
    <>
      <Button variant="ghost" size="sm" onClick={refresh}>
        {translate('routineConversation.refresh', 'Refresh')}
      </Button>
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div
        role="region"
        aria-label={translate('routineConversation.transcript', 'Run conversation')}
        tabIndex={0}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scrollbar-sleek"
      >
        {loading ? (
          <p role="status">{translate('routineConversation.loading', 'Loading conversation…')}</p>
        ) : null}
        {!loading && !error && !turns.length ? (
          <p className="text-sm text-muted-foreground">
            {translate('routineConversation.empty', 'No messages in this run yet.')}
          </p>
        ) : null}
        {turns.map((turn) => (
          // The hub ids every stored turn; the fallback only covers a turn echoed before it has one.
          <article
            key={turn.id ?? `${turn.created_at ?? ''}:${turn.role ?? ''}:${turnText(turn)}`}
            className="space-y-1 text-sm"
          >
            <p className="font-medium">
              {turn.role !== 'user'
                ? translate('routineConversation.agent', 'Agent')
                : own.some((sent) => sameTurn(sent, turn))
                  ? translate('routineConversation.you', 'You')
                  : translate('routineConversation.teammate', 'Teammate')}
            </p>
            <p className="whitespace-pre-wrap break-words">{turnText(turn)}</p>
            {turn.created_at ? (
              <time className="text-xs text-muted-foreground" dateTime={turn.created_at}>
                {new Date(turn.created_at).toLocaleString()}
              </time>
            ) : null}
          </article>
        ))}
      </div>
      <RoutineConversationComposer
        taskId={taskId}
        onPosted={(turn) => {
          posted.set(taskId, [...(posted.get(taskId) ?? []), turn])
          rerender((value) => value + 1)
          refresh()
        }}
      />
    </>
  )
}
