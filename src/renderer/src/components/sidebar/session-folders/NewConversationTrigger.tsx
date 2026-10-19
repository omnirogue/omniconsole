import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { HoverOpenAnchorProps } from '@/components/next-step/use-hover-open-popover'
import { translate } from '@/i18n/i18n'

export function NewConversationTrigger({
  starting,
  onStart,
  hover,
  folderName
}: {
  starting: boolean
  onStart: () => void
  hover: HoverOpenAnchorProps
  /** Set on a folder's own "+"; the conversation it starts is filed in that folder. */
  folderName?: string
}): React.JSX.Element {
  const label =
    folderName === undefined
      ? translate('conversations.newConversation', 'New conversation')
      : translate('conversations.newConversationInFolder', 'New conversation in {{folder}}', {
          folder: folderName
        })
  return (
    <DropdownMenuTrigger asChild>
      <Button
        {...hover}
        size={folderName === undefined ? 'xs' : 'icon-xs'}
        variant="ghost"
        className={
          folderName === undefined
            ? 'shrink-0 gap-1.5 px-2 text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
            : 'shrink-0 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
        }
        // Why two markers: tests and tours find the one toolbar "+" by data-new-conversation.
        data-new-conversation={folderName === undefined ? '' : undefined}
        data-new-conversation-folder={folderName === undefined ? undefined : ''}
        title={folderName === undefined ? undefined : label}
        disabled={starting}
        aria-busy={starting}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault()
          onStart()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault()
            hover.onKeyDown({
              ...event,
              key: 'ArrowDown',
              preventDefault: () => event.preventDefault()
            })
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onStart()
          }
        }}
      >
        {folderName === undefined ? (
          <>
            <span className="capitalize">{label}</span>
            <Plus className="size-4" aria-hidden />
          </>
        ) : (
          <>
            <Plus className="size-3.5" aria-hidden />
            <span className="sr-only">{label}</span>
          </>
        )}
      </Button>
    </DropdownMenuTrigger>
  )
}
