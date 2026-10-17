import React from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { NeedsYouQuestionRow } from './NeedsYouQuestionRow'
import { useSessionQuestionsInline } from './use-session-question-rows'

function open(session: SidebarSession): void {
  void activateSidebarSession(session).then((opened) => {
    if (!opened) {
      toast.error(
        translate('needsYou.openFailed', 'This session could not be opened; check its workspace.')
      )
    }
  })
}

/** The expanded Needs you line's questions, each answerable in place (rows without one draw nothing). */
export function NeedsYouQuestionList({
  sessions
}: {
  sessions: readonly SidebarSession[]
}): React.JSX.Element | null {
  const inline = useSessionQuestionsInline()
  const asking = sessions.filter((session) => session.paneKey)
  if (!inline || asking.length === 0) {
    return null
  }
  return (
    <ul
      className="space-y-1 px-2 pb-1"
      aria-label={translate('needsYou.questionsLabel', 'Questions waiting for you')}
    >
      {asking.map((session) => (
        <NeedsYouQuestionRow
          key={session.rowKey}
          paneKey={session.paneKey as string}
          title={session.label}
          onOpen={() => open(session)}
        />
      ))}
    </ul>
  )
}
