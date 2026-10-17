import { useRef, type ReactNode, type KeyboardEvent } from 'react'
import { Star, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import { translate } from '@/i18n/i18n'

export function LauncherMenuRow({
  children,
  submenu,
  onLaunch,
  onDefault,
  onRemove,
  removeLabel,
  isDefault,
  defaultLabel,
  disabled,
  hover
}: {
  children: ReactNode
  submenu?: ReactNode
  onLaunch: () => void
  onDefault?: () => void
  /** Shows an always-visible delete button on the row. */
  onRemove?: () => void
  removeLabel?: string
  isDefault?: boolean
  /** Replaces the trailing "Default" text, e.g. "Last used" for a remembered pick. */
  defaultLabel?: string
  disabled?: boolean
  hover: HoverOpenContentProps
}): React.JSX.Element {
  const defaultPointer = useRef(false)
  const onKeyDown = (event: KeyboardEvent): void => {
    defaultPointer.current = false
    if (event.key.toLowerCase() === 'd' && onDefault && !disabled) {
      event.preventDefault()
      event.stopPropagation()
      onDefault()
    }
  }
  const shortcut = onDefault
    ? translate('conversationLauncher.defaultShortcut', 'Press D to make default')
    : undefined
  const content = (
    <>
      <div className="min-w-0 flex-1">{children}</div>
      {isDefault ? (
        <span className="text-xs text-muted-foreground">
          {defaultLabel ?? translate('conversationLauncher.default', 'Default')}
        </span>
      ) : onDefault ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={translate('conversationLauncher.makeDefault', 'Make default')}
          onPointerDown={(event) => {
            defaultPointer.current = true
            event.stopPropagation()
          }}
          onPointerUp={(event) => event.stopPropagation()}
          title={shortcut}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            defaultPointer.current = false
            onDefault()
          }}
        >
          <Star className="size-3" />
        </Button>
      ) : null}
      {onRemove ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          aria-label={removeLabel}
          title={removeLabel}
          disabled={disabled}
          onPointerDown={(event) => {
            defaultPointer.current = true
            event.stopPropagation()
          }}
          onPointerUp={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            defaultPointer.current = false
            onRemove()
          }}
        >
          <Trash2 className="size-3" />
        </Button>
      ) : null}
    </>
  )
  if (!submenu || disabled) {
    return (
      <DropdownMenuItem
        className="group"
        disabled={disabled}
        title={shortcut}
        aria-keyshortcuts={onDefault ? 'd' : undefined}
        onKeyDown={onKeyDown}
        onPointerDownCapture={() => {
          defaultPointer.current = false
        }}
        onSelect={(event) => {
          if (defaultPointer.current) {
            defaultPointer.current = false
            event.preventDefault()
            return
          }
          event.preventDefault()
          onLaunch()
        }}
      >
        {content}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="group"
        title={shortcut}
        aria-keyshortcuts={onDefault ? 'd' : undefined}
        onClick={(event) => {
          event.preventDefault()
          onLaunch()
        }}
        onKeyDown={(event) => {
          onKeyDown(event)
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onLaunch()
          }
        }}
      >
        {content}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-80 max-h-96 overflow-y-auto scrollbar-sleek"
        onPointerMove={hover.onPointerMove}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
        onPointerDownCapture={hover.onPointerDownCapture}
      >
        {submenu}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
