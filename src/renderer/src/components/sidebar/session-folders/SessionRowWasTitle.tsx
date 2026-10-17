import React, { useEffect } from 'react'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useStewardTitleCaptions } from '@/store/steward-title-captions'

/** "was: <old title>" for a day after the steward re-titled the session to its new goal. */
export function SessionRowWasTitle({
  session
}: {
  session: SidebarSession
}): React.JSX.Element | null {
  const was = useStewardTitleCaptions((state) => state.captions[conversationViewKey(session)])
  const refresh = useStewardTitleCaptions((state) => state.refresh)
  useEffect(() => {
    refresh()
  }, [refresh])
  if (!was) {
    return null
  }
  return (
    <span
      className="block truncate text-xs font-normal text-muted-foreground"
      data-session-was-title=""
    >
      {translate('sessions.row.wasTitle', 'was: {{title}}', { title: was })}
    </span>
  )
}
