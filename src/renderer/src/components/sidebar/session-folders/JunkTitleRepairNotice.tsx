import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { renameSessionsFromGoals } from '@/lib/session-title-change'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import {
  dismissJunkTitleNotice,
  isJunkTitleNoticeDismissed,
  junkTitleExample
} from './junk-title-repair'
import { useJunkTitleRepairs } from './use-junk-title-repairs'

/**
 * One offer for rows whose own title is a launcher id. Those titles may be the person's, so they
 * change only on this click, with one Undo; Dismiss hides the offer on this device. The Work
 * page's Steward activity card makes the same offer, so this one stays away while Work is open.
 */
export function JunkTitleRepairNotice({
  sessions
}: {
  sessions: readonly SidebarSession[]
}): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(isJunkTitleNoticeDismissed)
  const onWork = useAppStore((state) => state.activeView === 'work')
  const repairs = useJunkTitleRepairs(sessions)
  if (dismissed || onWork || repairs.length === 0) {
    return null
  }
  const example = junkTitleExample(repairs)
  return (
    <div
      className="flex flex-wrap items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
      data-junk-title-notice=""
    >
      <span className="min-w-0 flex-1">
        {repairs.length === 1
          ? translate(
              'conversations.junkTitles.noticeOne',
              '1 session has a launcher title like {{example}}',
              { example }
            )
          : translate(
              'conversations.junkTitles.noticeMany',
              '{{count}} sessions have launcher titles like {{example}}',
              { count: repairs.length, example }
            )}
      </span>
      <Button variant="ghost" size="xs" onClick={() => renameSessionsFromGoals(repairs, 'notice')}>
        {translate('conversations.junkTitles.rename', 'Rename from their goals')}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          dismissJunkTitleNotice()
          setDismissed(true)
        }}
      >
        {translate('conversations.junkTitles.dismiss', 'Dismiss')}
      </Button>
    </div>
  )
}
