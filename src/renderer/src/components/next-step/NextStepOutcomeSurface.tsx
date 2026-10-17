import type { ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { PopoverContent } from '@/components/ui/popover'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

/**
 * Popovers normally sit one tier above dialogs so a picker inside a dialog stays reachable.
 * This surface is the exception: it hosts controls that open dialogs of their own (Create
 * task, the host file browser), so it takes the dialog tier and any dialog opened from inside
 * — mounted later in the document — stacks above it, while its own menus and pickers keep
 * their higher tiers.
 */
export const NEXT_STEP_SURFACE_CLASS = 'z-50 w-[min(680px,calc(100vw-1rem))] p-0'

export function NextStepOutcomeSurface({
  open,
  onOpenChange,
  presentation,
  onPointerEnter,
  onPointerLeave,
  onPin,
  onInteractOutside,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presentation: 'dialog' | 'popover'
  onPointerEnter?: () => void
  onPointerLeave?: () => void
  onPin?: () => void
  onInteractOutside?: (event: { target: EventTarget | null; preventDefault: () => void }) => void
  children: ReactNode
}): React.JSX.Element {
  if (presentation === 'popover') {
    return (
      <PopoverContent
        side="right"
        align="start"
        sideOffset={4}
        className={NEXT_STEP_SURFACE_CLASS}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerDownCapture={onPin}
        onInteractOutside={onInteractOutside}
      >
        {open ? children : null}
      </PopoverContent>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] max-w-3xl overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{translate('nextStep.nextActions', 'Next actions')}</DialogTitle>
          <DialogDescription>
            {translate(
              'nextStep.saveOutcomeAndKeepWorking',
              'Save the outcome and keep working until it is met.'
            )}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
