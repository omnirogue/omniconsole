import { useState } from 'react'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useSessionSidebarView } from '@/store/session-sidebar-view'

function shortDate(at: number, now: number): string {
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(getIntlLocale(), {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  })
}

/**
 * When an archived row was put away, at rest on its right edge, so old sessions can be found
 * and cleared by age. A row archived before the date was kept shows when it finished instead.
 */
export function SessionRowArchivedDate({
  viewKey,
  finishedAt
}: {
  viewKey: string
  finishedAt: number | null
}): React.JSX.Element | null {
  const archivedAt = useSessionSidebarView((state) => state.view.archivedAt?.[viewKey])
  const automatic = useSessionSidebarView(
    (state) =>
      state.view.autoArchiveLog?.findLast((entry) => entry.key === viewKey)?.restoredAt ===
        undefined && state.view.autoArchiveLog?.some((entry) => entry.key === viewKey) === true
  )
  // Why once: only the year's visibility depends on the clock, and it changes once a year.
  const [now] = useState(Date.now)
  const at = archivedAt ?? finishedAt
  if (at === null || at === undefined) {
    return null
  }
  const full = new Date(at).toLocaleString(getIntlLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  const title =
    archivedAt !== undefined
      ? translate('conversations.archivedOn', 'Archived {{date}}', {
          date: full
        })
      : translate('conversations.finishedOn', 'Finished {{date}}', {
          date: full
        })
  return (
    <span
      className="shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground"
      title={
        automatic
          ? translate(
              'conversations.autoArchivedOn',
              'Automatically archived after verified completion · {{date}}. History is kept. Unarchive to keep visible.',
              { date: full }
            )
          : title
      }
      data-session-archived-at={at}
    >
      {shortDate(at, now)}
    </span>
  )
}
