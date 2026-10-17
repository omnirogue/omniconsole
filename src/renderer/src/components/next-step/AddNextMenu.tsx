import { useEffect, useRef, useState, type AriaRole, type ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { NextStepSubject } from './next-step-subject'
import { AddNextPanels } from './add-next/AddNextPanels'

export function AddNextMenu({
  subject,
  label,
  visibleLabel,
  initialKind,
  primary = false,
  disabled = false,
  disabledReason,
  className,
  triggerContent,
  triggerRole,
  onSent
}: {
  subject: NextStepSubject
  label?: string
  visibleLabel?: string
  initialKind?: 'agent' | 'person'
  primary?: boolean
  disabled?: boolean
  disabledReason?: string | null
  className?: string
  triggerContent?: ReactNode
  triggerRole?: AriaRole
  onSent?: () => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = (): void => {
    if (timer.current) {
      clearTimeout(timer.current)
    }
  }
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    []
  )
  const show = (): void => {
    if (disabled) {
      return
    }
    if (disabledReason) {
      toast.message(disabledReason)
      return
    }
    setOpen(true)
  }
  const enter = (): void => {
    clear()
    // Why: passing the pointer over a control that cannot open must stay silent; only a
    // click or a keypress explains why.
    if (disabled || disabledReason) {
      return
    }
    if (!open && window.matchMedia?.('(hover: hover)').matches) {
      timer.current = setTimeout(show, 120)
    }
  }
  const leave = (): void => {
    clear()
    if (!pinned.current) {
      timer.current = setTimeout(() => setOpen(false), 250)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clear()
        setOpen(next)
        if (!next) {
          pinned.current = false
        }
      }}
    >
      <PopoverAnchor asChild>
        <Button
          ref={trigger}
          variant={primary ? 'default' : visibleLabel ? 'outline' : 'ghost'}
          size={visibleLabel ? 'sm' : triggerContent ? 'xs' : 'icon-xs'}
          className={className}
          disabled={disabled}
          aria-label={label ?? translate('nextStep.addNext', 'Add Next')}
          aria-haspopup="menu"
          aria-expanded={open}
          data-next-step-control="add"
          role={triggerRole}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onKeyDown={(event) => {
            if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
              event.preventDefault()
              clear()
              pinned.current = true
              show()
              requestAnimationFrame(() =>
                panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
              )
            }
          }}
          onClick={() => {
            clear()
            if (open && pinned.current) {
              pinned.current = false
              setOpen(false)
            } else {
              pinned.current = true
              show()
            }
          }}
        >
          {triggerContent ?? (
            <>
              <Plus className="size-3.5" />
              {visibleLabel}
            </>
          )}
        </Button>
      </PopoverAnchor>
      <PopoverContent
        ref={panel}
        side="right"
        align="start"
        sideOffset={4}
        className="scrollbar-sleek max-h-[80vh] w-max max-w-[calc(100vw-1rem)] overflow-auto p-0"
        onInteractOutside={(event) => {
          if (event.target instanceof Node && trigger.current?.contains(event.target)) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
        }}
        onEscapeKeyDown={() => {
          clear()
          pinned.current = false
          setOpen(false)
          trigger.current?.focus()
        }}
        onPointerEnter={clear}
        onPointerLeave={leave}
        onPointerDownCapture={() => {
          pinned.current = true
          clear()
        }}
      >
        {open ? (
          <AddNextPanels
            subject={subject}
            initialKind={initialKind}
            isPinned={() => pinned.current}
            onSent={() => {
              setOpen(false)
              pinned.current = false
              onSent?.()
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
