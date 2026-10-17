import type { ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** A conversation's name; hovering the row reveals ✎ right after it. */
export function ConversationRowTitle({
  title,
  onStartRename,
  trailing
}: {
  title: string
  /** Absent when the row cannot be renamed. */
  onStartRename?: () => void
  /** A small mark at the line's end (the to-do badge); the name truncates before it does. */
  trailing?: ReactNode
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <span className="truncate text-[13px]">{title}</span>
      {onStartRename ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why a span: the title sits inside the row's open button, which cannot hold a button. F2 is the keyboard path. */}
            <span
              role="button"
              tabIndex={-1}
              aria-label={translate('conversations.renameAria', 'Rename {{title}}', { title })}
              data-conversation-rename=""
              // Why hidden, not transparent: at rest the name keeps the width the pencil would take.
              className="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground group-hover:inline-flex hover:bg-foreground/10 hover:text-foreground [@media(hover:none)]:inline-flex"
              // Why: no focus move, text selection or row drag may start from the pencil.
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                // Modified clicks still select the row when its revealed pencil is under the pointer.
                const mod = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
                if (mod || event.shiftKey) {
                  return
                }
                event.preventDefault()
                event.stopPropagation()
                onStartRename()
              }}
            >
              <Pencil className="size-3" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{translate('conversations.rename', 'Rename')}</TooltipContent>
        </Tooltip>
      ) : null}
      {trailing}
    </span>
  )
}
