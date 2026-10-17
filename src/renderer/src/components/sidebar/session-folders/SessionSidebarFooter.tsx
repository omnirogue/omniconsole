import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { BackgroundTerminalsGroup } from './BackgroundTerminalsGroup'

/**
 * Under the Conversations list: processes running in the background (not in a window), then the
 * two reveal toggles, hidden groups and archived rows.
 */
export function SessionSidebarFooter({
  hiddenCount,
  showHidden,
  onShowHidden,
  archivedCount,
  showArchived,
  onShowArchived
}: {
  hiddenCount: number
  showHidden: boolean
  onShowHidden: (show: boolean) => void
  archivedCount: number
  showArchived: boolean
  onShowArchived: (show: boolean) => void
}): React.JSX.Element {
  return (
    <>
      <BackgroundTerminalsGroup />
      {hiddenCount > 0 ? (
        <div className="shrink-0 border-t border-worktree-sidebar-border px-2 py-1">
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-start gap-1.5 text-muted-foreground"
            aria-pressed={showHidden}
            onClick={() => onShowHidden(!showHidden)}
          >
            {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {showHidden
              ? translate(
                  'auto.components.SessionSidebar.hideHiddenGroups',
                  'Hide {{count}} hidden',
                  {
                    count: hiddenCount
                  }
                )
              : translate(
                  'auto.components.SessionSidebar.showHiddenGroups',
                  'Show {{count}} hidden',
                  {
                    count: hiddenCount
                  }
                )}
          </Button>
        </div>
      ) : null}
      {archivedCount > 0 || showArchived ? (
        <div className="shrink-0 border-t border-worktree-sidebar-border px-2 py-1">
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-start gap-1.5 text-muted-foreground"
            aria-pressed={showArchived}
            onClick={() => onShowArchived(!showArchived)}
          >
            {showArchived ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {showArchived
              ? translate('conversations.hideArchived', 'Hide archived')
              : translate('conversations.showArchived', 'Show archived ({{count}})', {
                  count: archivedCount
                })}
          </Button>
        </div>
      ) : null}
      {/* Why here: the footer renders once per sidebar, so one project dialog serves every heading. */}
    </>
  )
}
