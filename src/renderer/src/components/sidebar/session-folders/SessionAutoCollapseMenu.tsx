import { SessionAutoArchiveOptions } from './SessionAutoArchiveOptions'
import { Timer, TimerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import { sessionFolderAutoCollapseSeconds } from '@/lib/session-sidebar-view'
import type { ConversationRoutineGroup } from '@/lib/conversation-routine-rows'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionFolderAutoCollapse } from './use-session-folder-auto-collapse'

const CHOICES = [3, 5, 10, 20, 60, 300] as const

function choiceLabel(seconds: number): string {
  return seconds >= 60
    ? translate('conversations.autoCollapseMinutes', 'After {{count}} min', {
        count: seconds / 60
      })
    : translate('conversations.autoCollapseSeconds', 'After {{count}} seconds', {
        count: seconds
      })
}

/**
 * How long an idle open group waits before it folds itself (Off keeps folders as left), and
 * the timer that does the folding — both per device, from the sidebar view.
 */
export function SessionAutoCollapseMenu(props: {
  groups: readonly ConversationRoutineGroup[]
  metadata: SessionFolderMetadata
  currentKeys: readonly string[]
  listRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const seconds = useSessionSidebarView((state) => sessionFolderAutoCollapseSeconds(state.view))
  const onChange = useSessionSidebarView((state) => state.setAutoCollapseSeconds)
  const setCollapsed = useSessionSidebarView((state) => state.setCollapsed)
  useSessionFolderAutoCollapse({
    ...props,
    seconds,
    onCollapse: (keys) => setCollapsed(keys, true)
  })
  const label =
    seconds > 0
      ? translate('conversations.autoCollapseOn', 'Idle groups fold: {{when}}', {
          when: choiceLabel(seconds).toLowerCase()
        })
      : translate('conversations.autoCollapseOff', 'Idle groups stay open')
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={translate('conversations.sessionTimers', 'Session timers')}
          title={label}
        >
          {seconds > 0 ? <Timer className="size-3.5" /> : <TimerOff className="size-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 max-h-[80vh] overflow-y-auto scrollbar-sleek"
      >
        <DropdownMenuLabel>
          {translate('conversations.idleFoldTitle', 'Fold idle groups')}
        </DropdownMenuLabel>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {translate(
            'conversations.autoCollapseHelp',
            'Fold an open folder or group when nothing in it needs you and the session on screen is not in it. The group holding that session folds down to it, with Show all for the rest.'
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={String(seconds)}
          onValueChange={(value) => onChange(Number(value))}
        >
          {CHOICES.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={String(choice)}>
              {choiceLabel(choice)}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value="0">
            {translate('conversations.autoCollapseNever', 'Off')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <SessionAutoArchiveOptions />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
