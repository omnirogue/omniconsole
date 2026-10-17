import { useState, type AriaRole, type ReactElement, type ReactNode } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useHoverOpenPopover } from '@/components/next-step/use-hover-open-popover'
import type { NextStepSubject } from '@/components/next-step/next-step-subject'
import { UpNextSubject } from './UpNextSubject'

export function UpNextPopover({
  subject,
  disabledReason,
  done = false,
  triggerContent,
  triggerRole,
  className,
  open: openProp,
  onOpenChange,
  anchor,
  onChanged
}: {
  subject: NextStepSubject
  disabledReason?: string | null
  done?: boolean
  triggerContent?: ReactNode
  triggerRole?: AriaRole
  className?: string
  /** Controlled open, for a mount that opens the composer from somewhere else (a ⋮ menu). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * The element the controlled composer hangs off instead of its own trigger button. A menu
   * item cannot be that trigger: closing the menu would unmount the composer with it.
   */
  anchor?: ReactElement
  /** A committed chain changed this subject; the mount re-reads it. */
  onChanged?: () => void
}) {
  const [uncontrolled, setUncontrolled] = useState(false)
  const open = openProp ?? uncontrolled
  const setOpen = onOpenChange ?? setUncontrolled
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  // Why: a foreign anchor (the ⋮ button) opens its own menu on hover; the composer must not ride
  // along on it. Only this mount's own ＋ opens the composer on hover.
  const hovered = !anchor
  return (
    <Popover open={open} onOpenChange={hovered ? hover.onOpenChange : setOpen}>
      {anchor ? (
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      ) : (
        <PopoverAnchor asChild>
          <Button
            type="button"
            variant="ghost"
            size={triggerContent ? 'xs' : 'icon-sm'}
            role={triggerRole}
            className={className}
            disabled={Boolean(disabledReason)}
            title={disabledReason ?? undefined}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={done ? t('upNext.kind.done', 'Done') : t('upNext.title', 'Up next')}
            {...hover.anchorProps}
          >
            {triggerContent ?? (done ? '✓' : '＋')}
          </Button>
        </PopoverAnchor>
      )}
      <PopoverContent
        className="w-[min(48rem,90vw)] max-h-[80vh] overflow-y-auto scrollbar-sleek"
        // Why (Sal, 2026-09-18): the composer opens beside the ＋, not on top of it; Radix flips
        // it left or below only when the right edge has no room.
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        // Why: Radix never shifts a right-side box sideways; mid-window it ran rows' ↑↓✕ off-screen.
        style={{ maxWidth: 'var(--radix-popover-content-available-width)' }}
        data-up-next-composer
        {...(hovered ? hover.contentProps : {})}
      >
        <UpNextSubject subject={subject} onChanged={onChanged} />
      </PopoverContent>
    </Popover>
  )
}
