import { translate } from '@/i18n/i18n'

export function SessionSidebarEmpty({
  query,
  hiddenCount
}: {
  query: string
  hiddenCount: number
}) {
  return (
    <p className="px-2 py-4 text-xs text-muted-foreground">
      {query
        ? translate('auto.components.SessionSidebar.noMatchingSessions', 'No matching sessions.')
        : hiddenCount > 0
          ? translate(
              'auto.components.SessionSidebar.allGroupsHidden',
              'Every group is hidden. Show hidden groups to bring them back.'
            )
          : translate(
              'auto.components.SessionSidebar.noSessions',
              'No sessions here. Open an agent in any workspace to get started.'
            )}
    </p>
  )
}
