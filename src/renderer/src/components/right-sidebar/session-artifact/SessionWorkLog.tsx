import { useMemo } from 'react'
import { SessionActivityPanel } from '@/components/session-activity/SessionActivityPanel'
import { getIntlLocale, translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import {
  type SessionWorkLogTurn,
  sessionWorkLogTurns,
  statusWorkLogTurns
} from './session-work-log'
import { useWorkLogStatus } from './use-session-work-log-available'

const formatters = new Map<string, Intl.DateTimeFormat>()

function clockTime(at: number | null): string {
  if (at === null) {
    return ''
  }
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  const key = `${getIntlLocale()}:${today ? 'time' : 'day'}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      getIntlLocale(),
      today ? { timeStyle: 'short' } : { month: 'short', day: 'numeric' }
    )
    formatters.set(key, formatter)
  }
  return formatter.format(date)
}

function turnOutcome(turn: SessionWorkLogTurn): string {
  if (turn.result) {
    return turn.result
  }
  if (turn.ended === 'finished') {
    return translate('sessionActivity.stateDone', 'Finished its turn')
  }
  if (turn.ended === 'interrupted') {
    return translate('sessionActivity.stateInterrupted', 'Interrupted')
  }
  return turn.ended === 'failed'
    ? translate('sessionPanel.workLogFailed', 'Stopped with an error')
    : translate('sessionPanel.workLogNoReply', 'No reply yet')
}

/**
 * What the session is doing now, then each turn it took: what was asked, how many steps it ran
 * and its last line. The same view for every provider: from the transcript where the app reads
 * one, else from the agent's hook history.
 */
export function SessionWorkLog({
  session,
  messages
}: {
  session: SidebarSession
  messages: readonly NativeChatMessage[]
}): React.JSX.Element {
  const status = useWorkLogStatus(session)
  const transcriptTurns = useMemo(() => sessionWorkLogTurns(messages), [messages])
  const turns = useMemo(
    () => (transcriptTurns.length > 0 ? transcriptTurns : statusWorkLogTurns(status)),
    [transcriptTurns, status]
  )
  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-3" data-session-work-log="">
      <SessionActivityPanel session={session} messages={messages} />
      {turns.length > 0 ? (
        <ol className="mt-3 space-y-2.5 border-t pt-3">
          {turns.map((turn) => (
            <li key={turn.id} className="min-w-0 text-xs">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                  {clockTime(turn.startedAt)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium" title={turn.prompt}>
                  {turn.prompt}
                </span>
              </div>
              <p className="ml-16 truncate text-muted-foreground" title={turnOutcome(turn)}>
                {[
                  turn.steps === 1
                    ? translate('sessionPanel.workLogSteps_one', '1 step')
                    : turn.steps > 1
                      ? translate('sessionPanel.workLogSteps_other', '{{count}} steps', {
                          count: turn.steps
                        })
                      : null,
                  turnOutcome(turn)
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
